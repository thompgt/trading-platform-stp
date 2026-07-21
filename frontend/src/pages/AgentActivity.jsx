import { Card, Badge } from '../components/ui.jsx'
import { agents, agentActivityLog } from '../data/mockData.js'

export default function AgentActivity() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Agent Activity</h1>
        <p className="page-lede">
          Full agent roster (workplan.md §2) and a live-ish feed of what each agent has
          done recently.
        </p>
      </div>

      <Card title="Agent Roster">
        <table className="data-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Domain</th>
              <th>Nature</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.name}>
                <td>{a.name}</td>
                <td>{a.domain}</td>
                <td>{a.nature}</td>
                <td>
                  <Badge status={a.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Activity Log">
        <ul className="simple-list">
          {agentActivityLog.map((e, i) => (
            <li key={i}>
              <span className="simple-list-time">{e.time}</span>
              <span className="simple-list-text">
                <strong>{e.agent}</strong> — {e.action}
              </span>
              {e.kind === 'ai-draft' && <Badge status="low">AI draft</Badge>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
