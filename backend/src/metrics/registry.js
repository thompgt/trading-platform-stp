/**
 * Prometheus instrumentation for the STP backend.
 *
 * Two families of metric live here on purpose:
 *
 *  - *System* metrics (process CPU/memory/event-loop, HTTP throughput and latency,
 *    DuckDB query timing, LLM call latency and failures) — the operational picture the
 *    workplan calls for in §8/§9, scraped by Prometheus and drawn in Grafana.
 *  - *Trading* metrics (live session equity, P&L, drawdown, exposure) — so the same
 *    dashboard shows whether the platform is healthy *and* what it is doing. These are
 *    gauges reflecting the currently replayed sessions, not a system of record.
 *
 * Everything is registered against one module-level registry. `resetMetrics()` exists so
 * tests can assert on a clean slate without leaking counts between cases.
 */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client'

export const register = new Registry()

register.setDefaultLabels({ service: 'stp-backend' })

let defaultMetricsStarted = false

/**
 * Start collecting Node process metrics (CPU, resident memory, heap, event-loop lag, GC).
 * Kept opt-in rather than automatic: it installs process-wide collectors, which a test
 * run importing this module repeatedly shouldn't pay for.
 */
export function enableDefaultMetrics() {
  if (defaultMetricsStarted) return
  collectDefaultMetrics({ register, prefix: 'stp_' })
  defaultMetricsStarted = true
}

// Latency buckets tuned for a local API: sub-millisecond DuckDB reads up to slow LLM calls.
const API_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
const LLM_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60]

export const httpRequestsTotal = new Counter({
  name: 'stp_http_requests_total',
  help: 'HTTP requests handled, by method, matched route, and status code',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
})

export const httpRequestDuration = new Histogram({
  name: 'stp_http_request_duration_seconds',
  help: 'HTTP request latency in seconds, by method and matched route',
  labelNames: ['method', 'route', 'status'],
  buckets: API_BUCKETS,
  registers: [register],
})

export const httpRequestsInFlight = new Gauge({
  name: 'stp_http_requests_in_flight',
  help: 'HTTP requests currently being handled',
  registers: [register],
})

export const duckdbQueryDuration = new Histogram({
  name: 'stp_duckdb_query_duration_seconds',
  help: 'DuckDB query latency in seconds, by operation',
  labelNames: ['operation'],
  buckets: API_BUCKETS,
  registers: [register],
})

export const marketDataFetchDuration = new Histogram({
  name: 'stp_market_data_fetch_duration_seconds',
  help: 'Upstream Yahoo Finance fetch latency in seconds',
  labelNames: ['interval', 'outcome'],
  buckets: API_BUCKETS,
  registers: [register],
})

export const barsIngestedTotal = new Counter({
  name: 'stp_bars_ingested_total',
  help: 'Market data bars written into DuckDB',
  labelNames: ['symbol', 'interval'],
  registers: [register],
})

export const simulationSessionsStarted = new Counter({
  name: 'stp_simulation_sessions_started_total',
  help: 'Paper-trading replay sessions started',
  labelNames: ['symbol'],
  registers: [register],
})

export const simulationSessionsActive = new Gauge({
  name: 'stp_simulation_sessions_active',
  help: 'Paper-trading replay sessions currently held in memory',
  registers: [register],
})

export const simulationActionsTotal = new Counter({
  name: 'stp_simulation_actions_total',
  help: 'Replay control actions, by kind (step, rewind, jump, reset, strategy change)',
  labelNames: ['action'],
  registers: [register],
})

export const llmRequestsTotal = new Counter({
  name: 'stp_llm_requests_total',
  help: 'Groq agent calls, by agent and outcome (success, validation_failed, error)',
  labelNames: ['agent', 'outcome'],
  registers: [register],
})

export const llmRequestDuration = new Histogram({
  name: 'stp_llm_request_duration_seconds',
  help: 'Groq agent call latency in seconds, by agent',
  labelNames: ['agent'],
  buckets: LLM_BUCKETS,
  registers: [register],
})

export const llmValidationRetriesTotal = new Counter({
  name: 'stp_llm_validation_retries_total',
  help: 'Times a Groq response failed schema validation and was retried',
  labelNames: ['agent'],
  registers: [register],
})

export const riskAlertsTotal = new Counter({
  name: 'stp_risk_alerts_total',
  help: 'Risk alerts raised by the deterministic risk engine, by severity and agent',
  labelNames: ['severity', 'agent'],
  registers: [register],
})

export const analyticsSignalsTotal = new Counter({
  name: 'stp_analytics_signals_total',
  help: 'Technical-analytics signals generated, by indicator and direction',
  labelNames: ['indicator', 'direction'],
  registers: [register],
})

export const complianceDraftsTotal = new Counter({
  name: 'stp_compliance_drafts_total',
  help: 'Compliance triage drafts produced, by severity (draft-only, never auto-filed)',
  labelNames: ['severity'],
  registers: [register],
})

// --- Live trading gauges, one series per replayed symbol -----------------------------

export const sessionEquity = new Gauge({
  name: 'stp_session_equity_usd',
  help: 'Current equity of the live replay session, in USD',
  labelNames: ['symbol'],
  registers: [register],
})

export const sessionPnl = new Gauge({
  name: 'stp_session_pnl_usd',
  help: 'Cumulative P&L of the live replay session versus starting cash, in USD',
  labelNames: ['symbol'],
  registers: [register],
})

export const sessionReturnPct = new Gauge({
  name: 'stp_session_return_pct',
  help: 'Cumulative return of the live replay session, in percent',
  labelNames: ['symbol'],
  registers: [register],
})

export const sessionDrawdownPct = new Gauge({
  name: 'stp_session_drawdown_pct',
  help: 'Current drawdown from peak equity of the live replay session, in percent',
  labelNames: ['symbol'],
  registers: [register],
})

export const sessionMaxDrawdownPct = new Gauge({
  name: 'stp_session_max_drawdown_pct',
  help: 'Worst drawdown seen so far in the live replay session, in percent',
  labelNames: ['symbol'],
  registers: [register],
})

export const sessionExposurePct = new Gauge({
  name: 'stp_session_exposure_pct',
  help: 'Share of replayed bars spent holding a position, in percent',
  labelNames: ['symbol'],
  registers: [register],
})

export const sessionSharpe = new Gauge({
  name: 'stp_session_sharpe_ratio',
  help: 'Annualized Sharpe ratio of the live replay session',
  labelNames: ['symbol'],
  registers: [register],
})

export const sessionTrades = new Gauge({
  name: 'stp_session_trades',
  help: 'Trades executed so far in the live replay session',
  labelNames: ['symbol'],
  registers: [register],
})

/** Mirror a computed performance summary onto the per-symbol trading gauges. */
export function recordSessionPerformance(symbol, performance) {
  if (!symbol || !performance) return
  const labels = { symbol }
  sessionEquity.set(labels, performance.finalEquity)
  sessionPnl.set(labels, performance.totalPnl)
  sessionReturnPct.set(labels, performance.totalReturnPct)
  sessionDrawdownPct.set(labels, performance.currentDrawdownPct)
  sessionMaxDrawdownPct.set(labels, performance.maxDrawdownPct)
  sessionExposurePct.set(labels, performance.exposurePct)
  sessionSharpe.set(labels, performance.sharpe)
  sessionTrades.set(labels, performance.tradeCount)
}

/**
 * Time an async operation and record it on a histogram, tagging the outcome. Returns
 * whatever the operation returns and rethrows its error unchanged — instrumentation must
 * never swallow a failure.
 */
export async function observeDuration(histogram, labels, fn) {
  const end = histogram.startTimer(labels)
  try {
    const result = await fn()
    end()
    return result
  } catch (err) {
    end()
    throw err
  }
}

/** Clear all recorded values. Tests only — production never resets mid-process. */
export function resetMetrics() {
  register.resetMetrics()
}
