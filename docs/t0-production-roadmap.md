# Roadmap: a T+0 pipeline that is actually production ready

The target: an order enters, flows through pre-trade risk, execution, allocation and
settlement **the same day**, and every step of that journey is visible in a UI that also does
portfolio management and puts AI tools next to real data. Production ready means it survives a
restart, a bad actor, a concurrent user and a 3am page.

This document is deliberately blunt about the distance between that and what exists. It is
ordered so that each phase leaves the app working and demoable, and so that nothing early
gets rebuilt later.

---

## What already exists and does not need rebuilding

- **Post-trade engine** (`backend/src/posttrade/`) — trade capture, enrichment, confirmation
  matching, settlement instruction and DVP settlement, fails management, double-entry cash
  ledger, position keeping, custodian reconciliation, PDF reporting. Pure, deterministic,
  tested. This is the asset the rest of the plan is built around.
- **Replay/backtest engine** and the indicator + performance analytics libraries.
- **Observability**: Prometheus instrumentation, Grafana provisioning, RED metrics by route.
- **Operational baseline** (added in this pass): security headers, bounded bodies, liveness vs
  readiness probes, graceful drain on SIGTERM, structured logs with request correlation.

## The honest gap list

| # | Gap | Why it blocks the goal |
|---|---|---|
| 1 | No order/execution domain — no table, no state machine, no intake API | The Blotter and Portfolio pages render `frontend/src/data/mockData.js`. The lifecycle the UI monitors does not exist as data. |
| 2 | Nothing durable except bars; sessions and settlement runs are in-memory maps | A restart loses trade history. Unacceptable for anything settlement-related. |
| 3 | DuckDB is the only store | Single exclusive-locked connection, analytical engine. Right for bars, wrong for concurrent order writes. |
| 4 | Post-trade runs as a batch procedure over supplied fills | T+0 settlement is continuous and event-driven, with intraday cash and securities availability checks. |
| 5 | No append-only event log | No state transition is reconstructible; there is no audit trail to show anyone. |
| 6 | One shared API key, embedded in the browser bundle | No users, no roles, no maker-checker approvals for the steps that need a human signature. |
| 7 | Polling only | Lifecycle monitoring needs push (SSE) or the UI is always stale. |
| 8 | No app container, migrations, backups, alert rules, or secrets handling | Not deployable by anyone but its author, on the machine it was written on. |
| 9 | AI tools cannot see the platform's own data; no evals, no prompt audit, no cost budget | "AI tools" that can't answer "why did order X fail" are a demo, not a tool. |
| 10 | No load test, no e2e test, no accessibility pass | Nothing establishes that it works under real volume or for real users. |

---

## Phases

Each phase is independently demoable and leaves `main` green.

### Phase 0 — Operational baseline *(in progress)*

Make the process behave like a service before adding surface to it.

- [x] Security headers, bounded request bodies, `trust proxy`
- [x] Liveness vs readiness split; graceful drain on SIGTERM with a hard deadline
- [x] Structured JSON logging with request-id correlation and credential redaction
- [x] Boot-time config validation — fail fast and loudly on a bad or unsafe configuration
- [ ] Dockerfile + compose for the app itself, joined to the existing monitoring stack
- [ ] Prometheus alert rules and a runbook for each one

### Phase 1 — The order domain, on a real transactional store

The foundation everything else stands on. Nothing here is UI work.

- [ ] Introduce SQLite (single-node) or Postgres for the OLTP side; DuckDB stays the
      analytical store for bars. A migration tool, checked in, applied at boot.
- [ ] Schema: `orders`, `executions`, `allocations`, `positions`, `cash_movements`, and an
      append-only `events` table every state change writes to.
- [ ] An explicit order state machine — `NEW → PENDING_RISK → WORKING → PARTIALLY_FILLED →
      FILLED → ALLOCATED → SETTLED`, plus `REJECTED` and `CANCELLED` — where transitions are
      the only way state changes, illegal transitions throw, and each one appends an event.
- [ ] Order intake API with **idempotency keys**, so a retried submission cannot double-book.
- [ ] Optimistic concurrency on every order write.

### Phase 2 — Straight-through flow, driven by events

- [ ] Pre-trade risk gate on the intake path, reusing `agents/riskEngine.js`.
- [ ] A simulated execution venue that fills working orders against replayed bars, emitting
      partial fills — so the blotter shows real movement.
- [ ] Wire the existing post-trade procedure to run **per trade, on settlement date**, rather
      than as a batch over supplied fills. T+0 means same-day, with intraday cash and
      securities availability checked before the instruction goes out.
- [ ] Fails handling and the exception queue as first-class, queryable state.

### Phase 3 — Real-time UI on real data

- [ ] SSE endpoint publishing lifecycle events; the frontend subscribes and updates live.
- [ ] Replace `mockData.js` — Order Blotter, Portfolio, Dashboard and Agent Activity read the
      real API. Delete the mock module in the same commit so nothing silently falls back.
- [ ] Order ticket UI: enter, amend, cancel, with the risk decision shown before submission.
- [ ] A per-order lifecycle timeline rendered from the event log — the single screen that
      makes "straight-through processing" legible.
- [ ] Portfolio management: live positions, cash, realized/unrealized P&L, exposure by
      symbol and asset class, all derived from the ledger rather than recomputed in the UI.
- [ ] Table virtualization and pagination — a blotter with 10k rows must not freeze a tab.

### Phase 4 — Identity and approvals

- [ ] Real users: session cookies, hashed credentials, login/logout. The browser stops
      carrying a shared platform key.
- [ ] Roles — trader, ops, compliance, read-only — enforced server-side per route.
- [ ] Maker-checker: the state transitions that need a human signature cannot be made by the
      same user who proposed them, and the approval is an event like any other.

### Phase 5 — AI tools worth the name

- [ ] Ground the copilot in the platform's own data: a tool-calling loop over read-only
      queries against orders, positions and the event log, so "why did order X fail to
      settle" is answerable and every answer cites the events it used.
- [ ] Compliance narration reads the real event log rather than a supplied summary.
- [ ] An eval suite: a fixed set of questions with expected citations, run in CI, so a model
      or prompt change cannot silently regress.
- [ ] Prompt/response audit trail, and a per-user token budget with the spend on the
      dashboard next to the trading metrics.

### Phase 6 — Hardening

- [ ] Load test the intake path; publish a latency SLO and alert on it.
- [ ] Backup and restore, rehearsed — a documented restore from a cold backup.
- [ ] Playwright e2e covering submit → fill → settle, run in CI.
- [ ] Accessibility pass on every page; keyboard-only operation of the blotter.
- [ ] Security review: dependency audit, authz test per route, secrets out of env files.

---

## Things that will not be true, and should be said out loud

Even at the end of this roadmap, this is a **simulation**. It does not connect to a real
venue, a real custodian, or a real payment rail; the market data is delayed and free; the
"counterparty" is a deterministic stub. The regulatory shapes it models — CAT-style
reporting, DVP settlement, maker-checker — are architectural references, not compliance.
That is a fine thing for it to be. It stops being fine the moment the README implies
otherwise, so the README says it plainly and should keep saying it.
