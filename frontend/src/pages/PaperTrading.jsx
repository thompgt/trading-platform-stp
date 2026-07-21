import { Card, Badge } from '../components/ui.jsx'
import { paperStrategies } from '../data/mockData.js'

export default function PaperTrading() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Paper Trading</h1>
        <p className="page-lede">
          Isolated simulation environment reusing the production order/risk pipeline
          against simulated fills (workplan.md §6). Strategies can originate manually or
          from the gen-AI Strategy Generation Agent.
        </p>
      </div>

      <Card title="Strategies">
        <table className="data-table">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Origin</th>
              <th>Trades</th>
              <th>P&amp;L</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {paperStrategies.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td className="strategy-origin">{s.origin}</td>
                <td>{s.trades}</td>
                <td className={s.pnl >= 0 ? 'value-pos' : 'value-neg'}>
                  {s.pnl >= 0 ? '+' : ''}
                  {s.pnl.toFixed(2)}
                </td>
                <td>
                  <Badge status={s.status}>{s.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
