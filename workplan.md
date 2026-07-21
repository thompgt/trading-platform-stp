# Multi-Agent STP Trading Platform — Design & Workplan

## 1. System Overview & Design Principles

**Goal:** minimize manual touchpoints across the full trade lifecycle — order entry → execution → allocation → settlement → reporting — for equities and listed derivatives (options/futures).

**Why multi-agent, not just microservices:** the platform is decomposed into autonomous, message-driven **agents** that map onto how a real trading operation is organized — a desk, a risk function, a compliance function, an ops function, each with bounded authority and escalation paths. Agents reason over events and either act within their authority or escalate to a human/another agent. This differs from ordinary CRUD microservices in that several agents (compliance surveillance, ops incident response, strategy generation, research copilot) are **gen-AI-native**: they draft, summarize, and recommend, but never autonomously execute anything irreversible or regulated.

**Design principles:**
- **Event-sourced state** — every order/trade/position change is an immutable event; current state is a projection. Gives free audit trail and replayability.
- **Idempotent processing** — every agent handler is safe to retry (dedup keys on order/event IDs) — critical when message buses redeliver.
- **Human-in-the-loop gates** — pre-trade risk breach, compliance alert, regulatory filing, and margin call escalation all have a mandatory human-approval step. AI agents propose; humans (or explicitly-authorized rules engines) dispose.
- **Audit everything** — immutable, timestamped, attributable log of every agent decision, including AI-generated ones (prompt, model, output, human disposition).
- **Defense in depth** — risk is checked pre-trade (hard gate), intraday (monitoring), and post-trade (surveillance) — no single control is load-bearing alone.

---

## 2. Agent Architecture

| Domain | Agent | Responsibility | Nature |
|---|---|---|---|
| Execution | **Order Intake** | Validate, normalize, enrich incoming orders (equities & derivatives) | Rules |
| Execution | **Smart Order Router (SOR)** | Venue/broker selection, algo selection (TWAP/VWAP/POV), best-ex logic | Rules + quant |
| Execution | **Execution Management** | Manage child orders, fills, partials, cancel/replace | Rules |
| Post-trade | **Allocation** | Split block fills across accounts/strategies | Rules |
| Post-trade | **Settlement** | Orchestrate T+1 (equities) / CCP clearing (derivatives), fails management | Rules |
| Post-trade | **Reconciliation** | Match internal blotter vs. custodian/broker/exchange reports, raise breaks | Rules + ML anomaly detection |
| Risk & Compliance | **Pre-Trade Risk** | Real-time buying power, concentration, margin, restricted-list gates | Rules (hard gate, low-latency) |
| Risk & Compliance | **Market Risk** | Intraday VaR, Greeks (derivatives), stress scenarios | Quant |
| Risk & Compliance | **Compliance Surveillance** | Spoofing/wash-trade/insider-pattern detection, alert triage, SAR/filing narrative drafts | Gen-AI-assisted (draft-only) |
| Risk & Compliance | **Regulatory Reporting** | CAT/OATS-style, Reg SHO, large-trader reporting | Rules |
| Portfolio & Analytics | **Portfolio Management** | Positions, realized/unrealized P&L, cash, corporate actions | Rules |
| Portfolio & Analytics | **Technical Analytics** | Indicator library, signal generation, backtest engine | Quant |
| Portfolio & Analytics | **Reporting & Charting** | Scheduled/ad hoc reports, chart rendering, NL-query copilot | Gen-AI copilot + rules |
| Strategy & Sim | **Paper Trading / Simulation** | Shadow execution env reusing the production pipeline against simulated fills | Rules |
| Strategy & Sim | **Strategy Generation** | Propose/iterate strategies, hand to backtest, promote to paper trading | Gen-AI |
| Ops | **Ops / Incident Response** | Summarize settlement fails, recon breaks, incidents; draft runbook remediation; page humans | Gen-AI-assisted |
| Orchestration | **Supervisor/Orchestrator** | Coordinates multi-agent workflows requiring human-approval gates (risk breach halting trading, large compliance alert) | Rules + state machine |

**Backbone:** all agents communicate over an event bus (pub/sub), not direct RPC — this is what makes the system independently scalable and lets new agents subscribe to existing event streams without touching upstream agents.

---

## 3. Core Workflow: Trade Lifecycle

```
1. Order Creation           → Order Intake Agent validates & enriches
2. Pre-Trade Risk/Compliance→ Pre-Trade Risk Agent gates on buying power,
                               concentration, margin, restricted lists
     ├─ FAIL → order rejected, reason logged, trader notified
     └─ PASS → continue
3. Smart Order Routing      → SOR Agent picks venue + execution algo
4. Venue Execution          → Execution Management Agent manages child orders
     ├─ Partial fill → loop until filled/cancelled
     └─ Cancel/Replace → re-enters routing
5. Fill Capture             → trade event published
6. Allocation                → Allocation Agent splits block fills to accounts/strategies
7. Affirmation                → counterparty/custodian confirms trade details
8. Clearing (derivatives only)→ margin call loop with Market Risk Agent;
                               unmet margin → Supervisor halts further trading on account
9. Settlement                 → Settlement Agent (T+1 equities / CCP derivatives)
     └─ Fail → Fails Management loop (Settlement Agent retries, escalates to
               Ops Agent for narrative + human resolution, buy-in process if unresolved)
10. Reconciliation            → Reconciliation Agent matches internal vs. external records
11. Reporting                 → Portfolio + Reporting Agents update position/P&L, generate
                                confirmations and regulatory feeds

Exception path — Compliance Hold: at any point, Compliance Surveillance Agent can flag an
order/trade pattern; Supervisor freezes the related order pending human compliance review.
```

**Latency budget note:** pre-trade risk is the tightest SLA in the whole chain (single-digit ms target) since it gates order release; downstream stages (settlement, reporting) tolerate seconds-to-minutes latency.

---

## 4. Core Workflow: Trade Settlement

- **Equities:** T+1 settlement. Allocation → affirmation (CTM/ALERT-style matching with custodian) → net settlement instruction to DTCC/NSCC-style clearing → cash/security movement → confirmation.
- **Derivatives (options/futures):** cleared through a CCP. Initial margin posted at trade entry; variation margin recalculated and called intraday/daily by Market Risk Agent working with Settlement Agent. Missed margin call → Supervisor escalates to account-level trading halt.
- **Fails management:** unsettled trades enter a fails queue; Settlement Agent retries automatically for a configurable window, then hands off to Ops Agent, which drafts a fail-cause summary (gen-AI) for human resolution; unresolved fails past a threshold trigger the buy-in process.
- **Corporate actions:** dividends, splits, symbol changes processed by Portfolio Management Agent; any action affecting an open unsettled trade re-triggers the Settlement Agent workflow.

---

## 5. Core Workflow: Risk Management & Compliance

**Three layers, deliberately redundant:**
1. **Pre-trade (hard gate):** buying power, position concentration, margin sufficiency, restricted/watch-list checks — blocking, synchronous, low-latency.
2. **Intraday (monitoring):** Market Risk Agent computes VaR and, for derivatives, Greeks against limits; breaches raise alerts to Supervisor, which can throttle or halt trading on an account/strategy.
3. **Post-trade (surveillance):** Compliance Surveillance Agent runs pattern detection (spoofing, wash trades, insider-trading-adjacent patterns) over the trade/order event stream, uses gen-AI to triage alerts (rank by severity, draft an explanation of *why* flagged) and to draft SAR/regulatory-filing narratives — **the agent never files**; a compliance officer reviews and submits.

**Guardrail (applies to every gen-AI agent in the system):** AI drafts, recommends, and explains; humans approve anything irreversible, financially binding, or regulatory. This is enforced structurally (the agent's only write-capable action for filings/orders is "propose", routed through the Supervisor's approval gate), not just as a policy statement.

---

## 6. Feature Workflows

- **Portfolio Management:** real-time position and P&L engine (realized/unrealized), cash and margin balances, corporate-actions processing feeding back into positions.
- **Reporting & Charting:** scheduled reports (EOD blotter, P&L, risk) plus ad hoc chart rendering; NL-query copilot lets a user ask "show my tech-sector exposure vs. last week" and get a generated chart + explanation, backed by the same portfolio data the rules-based reports use (gen-AI never invents numbers — it queries the data layer and formats/explains the result).
- **Technical Analytics:** indicator library (moving averages, RSI, MACD, etc.), signal/alert framework, backtesting engine that both the Technical Analytics Agent and Strategy Generation Agent depend on.
- **Paper Trading:** an isolated simulation environment that reuses the *same* order/risk/execution pipeline code as production, swapping only the venue-connectivity layer for a simulated-fill engine. This serves two purposes: strategy development sandbox for traders/quants, and a safe pre-prod validation environment for the agents themselves before they touch live order flow.

---

## 7. Gen AI Integration (cross-cutting)

| Surface | Function | Guardrail |
|---|---|---|
| Trading/Research Copilot | NL queries over portfolio/risk/market data, market commentary | Read-only over real data; no trade execution capability |
| Compliance Surveillance | Alert triage, SAR/filing narrative drafts | Draft-only; human sign-off required to file |
| Ops/Incident Response | Summarize fails/breaks/incidents, draft runbook-guided remediation steps | Drafts + pages humans; cannot execute remediation autonomously |
| Strategy Generation | Propose/iterate paper-trading strategies | Never touches live capital — output only enters the paper trading pipeline until manually promoted |

- **Model:** Amazon Bedrock (Claude) for all reasoning/drafting agents — chosen for strong instruction-following and long-context RAG use cases relevant to compliance/ops document synthesis.
- **RAG sources:** compliance policy docs, ops runbooks, historical strategy library, regulatory filing templates.
- **Evaluation/observability:** every AI output is logged with prompt, model version, and human disposition (approved/edited/rejected) — this log doubles as both an audit trail and a feedback dataset for prompt/model iteration.

---

## 8. AWS Platform & DevOps Architecture

- **Event backbone:** Amazon MSK (Kafka) for order/fill/market-data streams — chosen over Kinesis for the consumer-group replay semantics recon/surveillance agents need.
- **Compute:** EKS for agent services (independently scalable, containerized); Lambda for bursty/event-triggered work (report generation, scheduled reconciliation batches).
- **Data:**
  - Aurora PostgreSQL — transactional order/trade/position state.
  - Timestream (or self-managed TimescaleDB on RDS) — tick/market-data time series.
  - S3 + Glue/Athena — data lake for audit trail, backtests, regulatory archive (S3 Object Lock for immutability).
  - OpenSearch — surveillance pattern search and log analytics.
- **AI:** Bedrock (Claude) for gen-AI agents; SageMaker for quant/ML models (risk, anomaly detection, signal generation).
- **DevOps:**
  - IaC: Terraform, one module per agent service + shared platform modules.
  - CI/CD: GitHub Actions → CodePipeline/CodeDeploy, canary or blue-green per agent service (agents deploy independently — a SOR change shouldn't require redeploying Settlement).
  - Observability: OpenTelemetry → CloudWatch + Grafana; per-agent dashboards plus a cross-agent trace view for a single order's journey through the pipeline.
  - Resilience: multi-AZ by default, DR region for the settlement/compliance data path specifically (the parts with regulatory retention requirements), game-day chaos testing on the event bus and pre-trade risk path (the latency-critical one).
  - Secrets: Secrets Manager, least-privilege IAM per agent (no agent has broader permissions than its one job needs).
- **Scalability targets:** pre-trade risk path is the latency-sensitive one (target: single-digit ms); everything downstream of fill capture is throughput-sensitive and horizontally scaled via consumer group partitioning.

---

## 9. Security, Compliance & Operational Readiness

- Encryption at rest/in transit everywhere; data classification separating PII/trade-financial data from general telemetry.
- Least-privilege IAM scoped per agent — the Compliance Surveillance Agent, for instance, has read access to the event stream but no write path to order execution.
- Regulatory alignment is designed around the *shape* of controls found in SEC/FINRA-style regimes (CAT reporting, Reg SHO, best-execution review, SAR workflow) as an architectural reference point — not a substitute for actual legal/compliance review in a real deployment.
- DR: RTO/RPO targets tightest for the settlement and compliance data paths (regulatory retention + fails resolution can't tolerate extended downtime).
- Incident response is runbook-driven, with the Ops Agent acting as first responder/summarizer, always terminating in a human decision for anything customer- or capital-impacting.

---

## 10. Phased Build Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Foundations** | Event bus, IaC baseline, core data model (orders/trades/positions) | Can publish/consume a synthetic order event end to end |
| **1 — STP core loop (simulated)** | Order Intake, Pre-Trade Risk, SOR, Execution Mgmt, Paper Trading | An order flows fully through the pipeline in the paper trading sandbox |
| **2 — Post-trade** | Allocation, Settlement, Reconciliation, Portfolio Management | Simulated trade settles and reconciles automatically; P&L reflects it |
| **3 — Risk & compliance depth** | Market Risk, Compliance Surveillance, Regulatory Reporting | Margin call loop and a compliance-hold scenario both function with human-approval gates |
| **4 — Analytics & gen-AI surfaces** | Technical Analytics, Reporting & Charting (+copilot), Strategy Generation | NL-query copilot answers a real portfolio question; a generated strategy runs in paper trading |
| **5 — Hardening** | DR, chaos/game-day testing, security review, scale testing | Pre-trade risk path meets latency SLA under load; DR failover validated |

Each phase should be demoable independently — phase 1's exit criterion, for example, is a live walkthrough of an order moving through intake → risk → routing → execution entirely inside the paper trading environment, which is also the safest place to validate every subsequent agent before it ever touches live order flow.

---

## 11. Frontend Scaffolding Plan

The `frontend/` directory holds a Vite + React (JavaScript) single-page app that will
eventually visualize the agents/workflows above. Planned structure as features land:

- `src/pages/` — one view per major feature area: Dashboard, Order Blotter, Portfolio,
  Risk & Compliance, Reporting & Charting, Technical Analytics, Paper Trading, Agent
  Activity Log.
- `src/components/layout/` — shared shell: sidebar nav (by domain, matching section 2's
  table), top bar, breadcrumb.
- `src/components/` — reusable UI: charts, data tables, status badges, agent activity feed.
- `src/data/` or `src/api/` — initially mocked data matching the event/agent shapes
  described above; swapped for real API calls once a backend exists.

Near-term milestone: a static, mock-data-driven dashboard with working navigation across
all feature areas, deployable as a static site (e.g., GitHub Pages, Vercel, Amplify
Hosting) — validating the UX before any backend/agent implementation work begins.
