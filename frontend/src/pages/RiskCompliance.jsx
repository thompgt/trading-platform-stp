import { useState } from 'react'
import { Card, Badge } from '../components/ui.jsx'
import {
  fetchMarketData,
  getBars,
  startSimulation,
  stepSimulation,
  getSessionRisk,
  getSessionCompliance,
} from '../api/backend.js'

function isoDate(d) {
  return d.toISOString().slice(0, 10)
}

function defaultDateRange() {
  const end = new Date()
  const start = new Date()
  start.setMonth(start.getMonth() - 6)
  return { period1: isoDate(start), period2: isoDate(end) }
}

const DEFAULT_STRATEGY = { kind: 'sma_crossover', params: { fastPeriod: 10, slowPeriod: 30 } }

export default function RiskCompliance() {
  const [symbol, setSymbol] = useState('AAPL')
  const [{ period1, period2 }, setRange] = useState(defaultDateRange)

  const [riskAlerts, setRiskAlerts] = useState(null)
  const [complianceDrafts, setComplianceDrafts] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function handleAnalyze(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setRiskAlerts(null)
    setComplianceDrafts(null)
    try {
      await fetchMarketData(symbol, period1, period2)
      const { bars } = await getBars(symbol, { start: period1, end: period2 })
      if (bars.length === 0) {
        throw new Error(`No bars available for ${symbol} in that range`)
      }
      const { sessionId } = await startSimulation({ symbol, start: period1, end: period2, strategy: DEFAULT_STRATEGY })
      await stepSimulation(sessionId, bars.length)

      const [risk, compliance] = await Promise.all([getSessionRisk(sessionId), getSessionCompliance(sessionId)])
      setRiskAlerts(risk.alerts)
      setComplianceDrafts(compliance.drafts)
    } catch (err) {
      setError(err.message || 'Analysis failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Risk &amp; Compliance</h1>
        <p className="page-lede">
          Three redundant layers — pre-trade, intraday, post-trade — described in
          workplan.md §5. Risk alerts are computed by deterministic rules against a
          symbol's simulated trading session; compliance triage is drafted by the
          Groq-backed Compliance Surveillance agent from a deterministically-detected
          pattern and always requires human sign-off before any filing.
        </p>
      </div>

      <Card title="Analyze a Symbol" subtitle="Runs a full simulated session, then evaluates risk and compliance agents against it">
        <form className="inline-form" onSubmit={handleAnalyze}>
          <label>
            Symbol
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="AAPL" />
          </label>
          <label>
            From
            <input
              type="date"
              value={period1}
              onChange={(e) => setRange((r) => ({ ...r, period1: e.target.value }))}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={period2}
              onChange={(e) => setRange((r) => ({ ...r, period2: e.target.value }))}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Analyzing…' : 'Run Risk & Compliance Analysis'}
          </button>
        </form>
      </Card>

      {error && (
        <Card className="error-banner">
          <strong>Error:</strong> {error}
        </Card>
      )}

      <Card title="Market &amp; Pre-Trade Risk Alerts" subtitle="Rules-based — concentration, drawdown, and volatility limits">
        {riskAlerts === null ? (
          <p className="empty-state">Run an analysis above to see live risk alerts.</p>
        ) : riskAlerts.length === 0 ? (
          <p className="empty-state">No risk alerts — {symbol} stayed within all configured limits.</p>
        ) : (
          <ul className="alert-list">
            {riskAlerts.map((a) => (
              <li key={a.id} className="alert-item">
                <Badge status={a.severity} />
                <div>
                  <div className="alert-message">{a.message}</div>
                  <div className="alert-meta">
                    {a.agent} · {a.time}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Compliance Surveillance" subtitle="Gen-AI drafted triage — draft only, never auto-filed">
        {complianceDrafts === null ? (
          <p className="empty-state">Run an analysis above to see compliance triage drafts.</p>
        ) : complianceDrafts.length === 0 ? (
          <p className="empty-state">No suspicious order/trade patterns detected for {symbol} in this session.</p>
        ) : (
          <ul className="alert-list">
            {complianceDrafts.map((c) => (
              <li key={c.id} className="alert-item ai-item">
                <Badge status={c.severity} />
                <div>
                  <div className="alert-message">
                    {c.pattern} — <span className="mono">{c.symbol}</span>
                  </div>
                  <div className="ai-draft-box">
                    <span className="ai-draft-label">AI draft</span>
                    {c.aiDraft}
                  </div>
                  <div className="alert-meta">{c.status}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
