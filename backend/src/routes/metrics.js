import { Router } from 'express'
import { register } from '../metrics/registry.js'

/**
 * Two views of the same registry:
 *
 *  - `GET /metrics` — the Prometheus text exposition format, scraped by Prometheus and
 *    ultimately drawn in Grafana. Deliberately *not* under /api: scrape endpoints are
 *    conventionally at the root, and it isn't part of the app's JSON API surface.
 *  - `GET /api/metrics/summary` — a small JSON rollup for the in-app System Health page,
 *    so the dashboard can show live service health without embedding Grafana or making
 *    the browser parse the exposition format.
 */

function valuesOf(snapshot, name) {
  return snapshot.find((m) => m.name === name)?.values ?? []
}

/** Total of a counter/gauge, optionally restricted to values matching some labels. */
function total(snapshot, name, labelFilter = {}) {
  return valuesOf(snapshot, name)
    .filter((v) => Object.entries(labelFilter).every(([k, val]) => v.labels?.[k] === val))
    .reduce((sum, v) => sum + v.value, 0)
}

/** Single (unlabelled) gauge value. */
function gauge(snapshot, name) {
  return valuesOf(snapshot, name)[0]?.value ?? 0
}

/** Mean observation of a histogram, in milliseconds — sum/count, or 0 before any data. */
function avgMs(snapshot, name) {
  const values = valuesOf(snapshot, name)
  const sum = values.filter((v) => v.metricName === `${name}_sum`).reduce((a, v) => a + v.value, 0)
  const count = values.filter((v) => v.metricName === `${name}_count`).reduce((a, v) => a + v.value, 0)
  return count > 0 ? (sum / count) * 1000 : 0
}

/** Group a labelled counter into a { labelValue: total } object. */
function byLabel(snapshot, name, label) {
  const out = {}
  for (const v of valuesOf(snapshot, name)) {
    const key = v.labels?.[label] ?? 'unknown'
    out[key] = (out[key] ?? 0) + v.value
  }
  return out
}

/** Per-symbol view of the live trading gauges, keyed by symbol. */
function sessionsFrom(snapshot) {
  const bySymbol = new Map()
  const fields = {
    stp_session_equity_usd: 'equity',
    stp_session_pnl_usd: 'pnl',
    stp_session_return_pct: 'returnPct',
    stp_session_drawdown_pct: 'drawdownPct',
    stp_session_max_drawdown_pct: 'maxDrawdownPct',
    stp_session_exposure_pct: 'exposurePct',
    stp_session_sharpe_ratio: 'sharpe',
    stp_session_trades: 'trades',
  }
  for (const [metric, field] of Object.entries(fields)) {
    for (const v of valuesOf(snapshot, metric)) {
      const symbol = v.labels?.symbol
      if (!symbol) continue
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, { symbol })
      bySymbol.get(symbol)[field] = v.value
    }
  }
  return [...bySymbol.values()]
}

export function metricsRouter() {
  const router = Router()

  router.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', register.contentType)
      res.end(await register.metrics())
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/metrics/summary', async (req, res) => {
    try {
      const snapshot = await register.getMetricsAsJSON()

      const requests = total(snapshot, 'stp_http_requests_total')
      // 4xx and 5xx both count as errors here: a burst of 404s is as much a signal that
      // something is wired up wrong as a burst of 500s.
      const errors = valuesOf(snapshot, 'stp_http_requests_total')
        .filter((v) => Number(v.labels?.status) >= 400)
        .reduce((sum, v) => sum + v.value, 0)

      const startTimeSeconds = gauge(snapshot, 'stp_process_start_time_seconds')

      res.json({
        collectedAt: new Date().toISOString(),
        process: {
          // process.uptime() rather than the gauge, so this is right even when default
          // metrics collection is off (as it is under test).
          uptimeSeconds: Math.round(process.uptime()),
          startedAt: startTimeSeconds
            ? new Date(startTimeSeconds * 1000).toISOString()
            : new Date(Date.now() - process.uptime() * 1000).toISOString(),
          nodeVersion: process.version,
          residentMemoryMb: gauge(snapshot, 'stp_process_resident_memory_bytes') / 1024 / 1024,
          heapUsedMb: total(snapshot, 'stp_nodejs_heap_size_used_bytes') / 1024 / 1024,
          cpuSecondsTotal: gauge(snapshot, 'stp_process_cpu_seconds_total'),
          eventLoopLagMs: gauge(snapshot, 'stp_nodejs_eventloop_lag_mean_seconds') * 1000,
          activeHandles: gauge(snapshot, 'stp_nodejs_active_handles_total'),
        },
        http: {
          totalRequests: requests,
          errorRequests: errors,
          errorRatePct: requests > 0 ? (errors / requests) * 100 : 0,
          avgLatencyMs: avgMs(snapshot, 'stp_http_request_duration_seconds'),
          inFlight: gauge(snapshot, 'stp_http_requests_in_flight'),
          byRoute: Object.entries(byLabel(snapshot, 'stp_http_requests_total', 'route'))
            .map(([route, count]) => ({ route, count }))
            .sort((a, b) => b.count - a.count),
        },
        llm: {
          totalCalls: total(snapshot, 'stp_llm_requests_total'),
          byOutcome: byLabel(snapshot, 'stp_llm_requests_total', 'outcome'),
          byAgent: byLabel(snapshot, 'stp_llm_requests_total', 'agent'),
          avgLatencyMs: avgMs(snapshot, 'stp_llm_request_duration_seconds'),
          validationRetries: total(snapshot, 'stp_llm_validation_retries_total'),
        },
        data: {
          barsIngested: total(snapshot, 'stp_bars_ingested_total'),
          avgFetchMs: avgMs(snapshot, 'stp_market_data_fetch_duration_seconds'),
          avgQueryMs: avgMs(snapshot, 'stp_duckdb_query_duration_seconds'),
        },
        simulation: {
          activeSessions: gauge(snapshot, 'stp_simulation_sessions_active'),
          sessionsStarted: total(snapshot, 'stp_simulation_sessions_started_total'),
          actions: byLabel(snapshot, 'stp_simulation_actions_total', 'action'),
        },
        oversight: {
          riskAlerts: total(snapshot, 'stp_risk_alerts_total'),
          riskBySeverity: byLabel(snapshot, 'stp_risk_alerts_total', 'severity'),
          complianceDrafts: total(snapshot, 'stp_compliance_drafts_total'),
        },
        sessions: sessionsFrom(snapshot),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
