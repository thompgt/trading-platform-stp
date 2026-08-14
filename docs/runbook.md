# Runbook

One section per alert in `monitoring/prometheus/alerts.yml`. Each answers the same three
questions in the same order, because that is the order the person paged actually needs them:
**what is happening**, **how to confirm it**, **what to do**.

The rule for this file: if an alert fires and the responder still has to think from first
principles, the section is wrong and should be rewritten after the incident.

> This is a single-instance, simulated platform. Where a step below would be "fail over to
> the other region" in a real deployment, it says so plainly rather than pretending.

---

## Shared first steps

Every investigation starts the same way:

```bash
# Is the process up and answering, and is its database reachable?
curl -s localhost:4000/api/health   # liveness  — the process
curl -s localhost:4000/api/ready    # readiness — the process AND DuckDB

# What has it been doing? Logs are JSON lines; every request has a requestId.
docker logs stp-backend --since 15m | jq 'select(.level == "error")'

# Narrow to one request the user complained about:
docker logs stp-backend | jq 'select(.requestId == "<id from the error response>")'
```

A 5xx response body carries the `requestId`. Ask for it first — it turns a vague report into
an exact log line.

---

## BackendDown

**What is happening.** Prometheus cannot scrape `/metrics`.

**Confirm.** Check the `prometheus` job in the same dashboard. If *it* is also down, the
scraper is broken and the backend may be fine. If only the backend target is down, hit
`/api/health` directly — a healthy answer means the scrape target is misconfigured (the
port moved) rather than the service being dead.

**Do.**
1. `docker compose ps` — is the container running or restarting?
2. `docker logs stp-backend --tail 100` — a config failure exits **78** with every problem
   listed; that is a bad environment, not a crash. Fix and restart.
3. Exit code 1 with `uncaught exception` or `unhandled rejection` in the last lines: the
   process replaced itself deliberately. Capture the stack before restarting.
4. Port moved: update `monitoring/prometheus/prometheus.yml` and
   `curl -X POST localhost:9090/-/reload`.

## HighErrorRate

**What is happening.** More than 5% of requests are 5xx over five minutes.

**Confirm.** Group by route: `sum by (route) (rate(stp_http_requests_total{status=~"5.."}[5m]))`.
One route failing is a bug in that route; every route failing is the database or the process.

**Do.**
1. Check `/api/ready`. `database_unavailable` means the DuckDB handle is broken — restart the
   container; the file recovers its WAL on open.
2. Pull the error lines: `docker logs stp-backend --since 15m | jq 'select(.level=="error")'`.
   The real error is logged in full even though callers only see `Internal server error`.
3. If it is one route and one symbol, suspect the bar data for that symbol rather than the
   route — mixed bar sizes for a symbol are a known trap (see the README's limitations).

## SlowRequests

**What is happening.** p95 above 2s on a non-LLM route.

**Confirm.** `stp_duckdb_query_duration_seconds` — if DuckDB is slow, the API is downstream of
the real problem. `stp_strategy_replay_duration_seconds` — a long replay is CPU-bound and
blocks the event loop.

**Do.**
1. A replay over a long intraday range is genuinely expensive. Confirm the range before
   treating it as a fault.
2. Check `stp_http_requests_in_flight`: a rising, non-returning count means requests are
   piling up behind something synchronous, not just running slowly.
3. Nothing here is horizontally scalable today — the DuckDB file takes an exclusive lock, so a
   second instance cannot share it. Reducing load is the only lever until Phase 1 lands.

## EventLoopBlocked

**What is happening.** Event-loop lag p99 over 500ms for five minutes. Node is
single-threaded, so this starves *everything*, including the health probe.

**Confirm.** Correlate with `stp_strategy_replay_duration_seconds` and
`stp_simulation_sessions_active`.

**Do.**
1. Usually many concurrent replays. `stp_simulation_sessions_active` shows how many;
   `DELETE /api/simulation/:id` releases one immediately.
2. If lag is high with no sessions, take a CPU profile before restarting — a restart destroys
   the evidence and the cause will return.

## LlmFailureRate

**What is happening.** Over a quarter of Groq calls are failing.

**Confirm.** Split by outcome: `sum by (outcome) (rate(stp_llm_requests_total[10m]))`.
- `timeout` → upstream slowness or a network problem.
- `validation_failed` → the model stopped producing the schema we require.
- `error` → everything else, usually auth or rate limiting.

**Do.**
1. `timeout`: check Groq's status. `LLM_REQUEST_TIMEOUT_MS` and `LLM_DEADLINE_MS` bound the
   damage; raising them trades user-facing latency for success rate, so decide deliberately.
2. `validation_failed`: check whether `GROQ_MODEL` changed. A model swap is the usual cause;
   the retry loop already feeds validation errors back once before giving up.
3. `error` with 401/403 in the logs: the key is wrong or revoked.
4. These routes are rate-limited to 20/key/minute, so a failure spike cannot become a
   runaway bill — but confirm spend anyway if the failures are timeouts, since a timed-out
   request may still have been charged.

## SettlementBooksOutOfBalance

**What is happening.** `stp_settlement_books_in_balance == 0`: debits and credits disagree on
the last settlement run.

**This is the serious one.** It is a correctness failure in the ledger, not a data-quality
issue. Nothing from that run should be trusted, published, or sent to a counterparty until it
is explained.

**Confirm.**
```bash
curl -s -H "X-API-Key: $API_KEY" localhost:4000/api/settlement/<runId>/ledger | jq .trialBalance
```

**Do.**
1. The procedure is deterministic — same fills in, same journal out. Re-post the identical
   request; an identical imbalance confirms a code path rather than a transient.
2. Find the trade: the trial balance names the accounts that disagree, and `money.js` works in
   integer cents specifically so rounding cannot be the cause. If it appears to be rounding,
   something is converting to float somewhere and that is the bug.
3. Do not "fix" the report. Fix the ledger, add the case to `test/ledger.test.js`, re-run.

## SettlementUnreconciled

**What is happening.** Our positions and the custodian statement disagree.

**Confirm.** `GET /api/settlement/<runId>/breaks` lists each break with its reason.

**Do.**
1. Breaks are expected while trades are in flight; the alert exists so an unexplained one
   cannot sit unnoticed, not because every break is an incident.
2. Group by security and counterparty first — one bad static-data entry produces many breaks
   that look independent.
3. A break that survives a re-run of the same inputs is real. Escalate rather than clearing.

## StraightThroughRateLow

**What is happening.** Under 80% of captured fills reached SETTLED with no human touchpoint.

**Confirm.** The run's stage report shows where fills dropped out — enrichment, matching,
settlement or reconciliation.

**Do.**
1. Enrichment: usually missing static data for a new symbol (`posttrade/staticData.js`).
2. Matching: counterparty confirms disagreeing on economics — check whether one counterparty
   accounts for all of them.
3. Settlement: insufficient position or cash. On a T+0 timeline this is the one that costs
   money, so treat it as urgent rather than a report-quality issue.

## SettlementFailsSpike

**What is happening.** More than five fails in an hour.

**Do.**
1. Group by counterparty and security before treating them as separate incidents — a spike is
   almost always one cause.
2. Check the fails policy in `posttrade/settlement.js` is still what you intend.
3. Under T+0, a fail cannot be left to the next batch. Anything unexplained after the first
   pass is escalated, not requeued.
