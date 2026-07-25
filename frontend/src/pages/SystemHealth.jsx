import { useCallback, useEffect, useState } from 'react'
import { Card, Badge, StatTile } from '../components/ui.jsx'
import BarChart from '../components/charts/BarChart.jsx'
import { getMetricsSummary } from '../api/backend.js'

/**
 * Where the full Grafana dashboard lives. Overridable so a deployed instance can point at
 * a real Grafana rather than the local Compose stack in monitoring/.
 */
const GRAFANA_URL =
  import.meta.env.VITE_GRAFANA_URL || 'http://localhost:3001/d/stp-platform/stp-trading-platform'

const REFRESH_MS = 5000

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

const num = (v, digits = 0) =>
  Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—'

/** Error-rate tone thresholds mirror the Grafana panel's, so the two never disagree. */
function errorTone(pct) {
  if (pct >= 5) return 'tone-bad'
  if (pct >= 1) return 'tone-warn'
  return 'tone-good'
}

function latencyTone(ms) {
  if (ms >= 2000) return 'tone-bad'
  if (ms >= 500) return 'tone-warn'
  return 'tone-good'
}

export default function SystemHealth() {
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const data = await getMetricsSummary()
      setSummary(data)
      setError(null)
      setLastUpdated(new Date())
    } catch (err) {
      // Keep the last good snapshot on screen rather than blanking the page — a stale
      // reading plus an explicit warning is more useful than an empty dashboard.
      setError(err.message || 'Could not reach the metrics endpoint')
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  const llmOutcomes = summary ? Object.entries(summary.llm.byOutcome) : []
  const riskSeverities = summary ? Object.entries(summary.oversight.riskBySeverity) : []

  return (
    <div className="page">
      <div className="page-head">
        <h1>System Health</h1>
        <p className="page-lede">
          Live service metrics straight from the backend&apos;s Prometheus registry. The same
          series are scraped by Prometheus and charted in Grafana — this page is the
          at-a-glance view, the{' '}
          <a href={GRAFANA_URL} target="_blank" rel="noreferrer">
            Grafana dashboard
          </a>{' '}
          has the history, quantiles, and per-symbol P&amp;L panels (see{' '}
          <code>monitoring/</code>).
        </p>
      </div>

      {error && (
        <Card className="error-banner">
          <strong>Metrics unavailable:</strong> {error}
          {summary && ' — showing the last successful reading.'}
        </Card>
      )}

      {!summary && !error && <p className="empty-state">Loading metrics…</p>}

      {summary && (
        <>
          <Card
            title="Service"
            subtitle={
              lastUpdated
                ? `Refreshed every ${REFRESH_MS / 1000}s — last at ${lastUpdated.toLocaleTimeString()}`
                : undefined
            }
          >
            <div className="stat-grid">
              <StatTile label="Uptime" value={formatUptime(summary.process.uptimeSeconds)} delta={summary.process.nodeVersion} />
              <StatTile label="Requests Served" value={num(summary.http.totalRequests)} delta={`${num(summary.http.inFlight)} in flight`} />
              <StatTile
                label="Error Rate"
                value={`${num(summary.http.errorRatePct, 2)}%`}
                delta={`${num(summary.http.errorRequests)} of ${num(summary.http.totalRequests)}`}
                deltaTone={errorTone(summary.http.errorRatePct)}
              />
              <StatTile
                label="Avg Latency"
                value={`${num(summary.http.avgLatencyMs, 1)} ms`}
                delta="mean over all routes"
                deltaTone={latencyTone(summary.http.avgLatencyMs)}
              />
            </div>

            <div className="stat-grid">
              <StatTile label="Resident Memory" value={`${num(summary.process.residentMemoryMb, 1)} MB`} delta={`${num(summary.process.heapUsedMb, 1)} MB heap`} />
              <StatTile label="CPU Time" value={`${num(summary.process.cpuSecondsTotal, 1)} s`} delta="process total" />
              <StatTile
                label="Event-Loop Lag"
                value={`${num(summary.process.eventLoopLagMs, 2)} ms`}
                delta={summary.process.eventLoopLagMs >= 50 ? 'API is starving' : 'healthy'}
                deltaTone={summary.process.eventLoopLagMs >= 50 ? 'tone-bad' : 'tone-good'}
              />
              <StatTile label="Active Sessions" value={num(summary.simulation.activeSessions)} delta={`${num(summary.simulation.sessionsStarted)} started`} />
            </div>
          </Card>

          <Card title="Traffic by Route" subtitle="Requests counted against the matched route pattern, never the raw URL">
            <BarChart
              items={summary.http.byRoute.slice(0, 10).map((r) => ({ label: r.route, value: r.count }))}
              toneFor={() => 'neutral'}
              formatValue={(v) => num(v)}
              emptyLabel="No requests recorded yet."
            />
          </Card>

          <Card title="Data & Storage" subtitle="Market data ingestion and DuckDB query timing">
            <div className="stat-grid">
              <StatTile label="Bars Ingested" value={num(summary.data.barsIngested)} delta="into DuckDB" />
              <StatTile label="Avg Upstream Fetch" value={`${num(summary.data.avgFetchMs, 0)} ms`} delta="Yahoo Finance" />
              <StatTile label="Avg DuckDB Query" value={`${num(summary.data.avgQueryMs, 2)} ms`} />
              <StatTile
                label="Replay Actions"
                value={num(Object.values(summary.simulation.actions).reduce((a, b) => a + b, 0))}
                delta={
                  Object.entries(summary.simulation.actions)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(' · ') || 'none yet'
                }
              />
            </div>
          </Card>

          <Card
            title="Gen-AI Agents"
            subtitle="Groq calls by outcome. 'validation_failed' means the model never produced schema-valid JSON; 'error' means the API call itself failed."
          >
            <div className="stat-grid">
              <StatTile label="Agent Calls" value={num(summary.llm.totalCalls)} />
              <StatTile label="Avg Agent Latency" value={`${num(summary.llm.avgLatencyMs, 0)} ms`} delta="including retries" />
              <StatTile
                label="Schema Retries"
                value={num(summary.llm.validationRetries)}
                delta={summary.llm.validationRetries > 0 ? 'model output re-prompted' : 'none'}
                deltaTone={summary.llm.validationRetries > 0 ? 'tone-warn' : 'tone-good'}
              />
              <StatTile
                label="Failed Calls"
                value={num((summary.llm.byOutcome.validation_failed ?? 0) + (summary.llm.byOutcome.error ?? 0))}
                deltaTone="tone-bad"
              />
            </div>

            {llmOutcomes.length === 0 ? (
              <p className="empty-state">No agent calls yet this run.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Outcome</th>
                    <th>Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {llmOutcomes.map(([outcome, count]) => (
                    <tr key={outcome}>
                      <td>
                        <Badge status={outcome === 'success' ? 'healthy' : outcome === 'error' ? 'alert' : 'warning'}>
                          {outcome}
                        </Badge>
                      </td>
                      <td>{num(count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Oversight" subtitle="Counts from the deterministic risk engine and the draft-only compliance agent">
            <div className="stat-grid">
              <StatTile label="Risk Alerts" value={num(summary.oversight.riskAlerts)} />
              {riskSeverities.map(([severity, count]) => (
                <StatTile
                  key={severity}
                  label={`${severity[0].toUpperCase()}${severity.slice(1)} Severity`}
                  value={num(count)}
                  deltaTone={severity === 'high' ? 'tone-bad' : severity === 'medium' ? 'tone-warn' : undefined}
                />
              ))}
              <StatTile label="Compliance Drafts" value={num(summary.oversight.complianceDrafts)} delta="never auto-filed" />
            </div>
          </Card>

          <Card
            title="Live Replay Sessions"
            subtitle="Per-symbol trading gauges — the same series the Grafana P&L panels chart"
          >
            {summary.sessions.length === 0 ? (
              <p className="empty-state">No replay sessions running. Start one on the Paper Trading page.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Equity</th>
                    <th>P&amp;L</th>
                    <th>Return</th>
                    <th>Drawdown</th>
                    <th>Max DD</th>
                    <th>Exposure</th>
                    <th>Sharpe</th>
                    <th>Trades</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.sessions.map((s) => (
                    <tr key={s.symbol}>
                      <td className="mono">{s.symbol}</td>
                      <td>${num(s.equity)}</td>
                      <td className={s.pnl >= 0 ? 'value-pos' : 'value-neg'}>
                        {s.pnl >= 0 ? '+' : '-'}${num(Math.abs(s.pnl))}
                      </td>
                      <td className={s.returnPct >= 0 ? 'value-pos' : 'value-neg'}>{num(s.returnPct, 2)}%</td>
                      <td>{num(s.drawdownPct, 2)}%</td>
                      <td>{num(s.maxDrawdownPct, 2)}%</td>
                      <td>{num(s.exposurePct, 1)}%</td>
                      <td>{num(s.sharpe, 2)}</td>
                      <td>{num(s.trades)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
