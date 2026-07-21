import { Card, Badge, StatTile } from '../components/ui.jsx'
import { roadmapPhases, agentActivityLog, riskAlerts, positions } from '../data/mockData.js'

export default function Dashboard() {
  const totalUnrealized = positions.reduce((sum, p) => sum + p.unrealized, 0)
  const healthyAgents = 15
  const totalAgents = 17

  return (
    <div className="page">
      <div className="page-head">
        <h1>Dashboard</h1>
        <p className="page-lede">
          Snapshot of the multi-agent STP platform — mock data standing in for the live
          event bus until the backend agents exist. See <code>workplan.md</code> for the
          full design.
        </p>
      </div>

      <div className="stat-grid">
        <StatTile label="Unrealized P&L" value={`$${totalUnrealized.toLocaleString()}`} delta="+2.4% today" deltaTone="tone-good" />
        <StatTile label="Open Orders" value="4" delta="1 pending risk" deltaTone="tone-warn" />
        <StatTile label="Agents Healthy" value={`${healthyAgents} / ${totalAgents}`} delta="1 alert, 1 warning" deltaTone="tone-warn" />
        <StatTile label="Compliance Alerts" value="2" delta="1 needs review" deltaTone="tone-bad" />
      </div>

      <div className="two-col">
        <Card title="Build Roadmap" subtitle="Phased delivery — see workplan.md §10">
          <ul className="roadmap-list">
            {roadmapPhases.map((p) => (
              <li key={p.phase} className="roadmap-item">
                <div className="roadmap-phase">
                  Phase {p.phase} — {p.title}
                </div>
                <div className="roadmap-scope">{p.scope}</div>
                <Badge status={p.status}>{p.status.replace('-', ' ')}</Badge>
              </li>
            ))}
          </ul>
        </Card>

        <div className="stack">
          <Card title="Risk Alerts" subtitle="Live from Market Risk / Pre-Trade Risk agents">
            <ul className="simple-list">
              {riskAlerts.map((a) => (
                <li key={a.id}>
                  <Badge status={a.severity} />
                  <span className="simple-list-text">{a.message}</span>
                  <span className="simple-list-meta">{a.agent}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Agent Activity" subtitle="Most recent events across all agents">
            <ul className="simple-list">
              {agentActivityLog.slice(0, 4).map((e, i) => (
                <li key={i}>
                  <span className="simple-list-time">{e.time}</span>
                  <span className="simple-list-text">
                    <strong>{e.agent}</strong> — {e.action}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}
