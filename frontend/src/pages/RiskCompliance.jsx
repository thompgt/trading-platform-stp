import { Card, Badge } from '../components/ui.jsx'
import { riskAlerts, complianceAlerts } from '../data/mockData.js'

export default function RiskCompliance() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Risk &amp; Compliance</h1>
        <p className="page-lede">
          Three redundant layers — pre-trade, intraday, post-trade — described in
          workplan.md §5. Gen-AI compliance drafts always require human sign-off before
          any filing.
        </p>
      </div>

      <Card title="Market &amp; Pre-Trade Risk Alerts">
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
      </Card>

      <Card title="Compliance Surveillance" subtitle="Gen-AI drafted triage — draft only, never auto-filed">
        <ul className="alert-list">
          {complianceAlerts.map((c) => (
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
      </Card>
    </div>
  )
}
