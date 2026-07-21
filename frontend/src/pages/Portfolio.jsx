import { Card, StatTile } from '../components/ui.jsx'
import { positions } from '../data/mockData.js'

export default function Portfolio() {
  const totalUnrealized = positions.reduce((sum, p) => sum + p.unrealized, 0)
  const longs = positions.filter((p) => p.qty > 0).length
  const shorts = positions.filter((p) => p.qty < 0).length

  return (
    <div className="page">
      <div className="page-head">
        <h1>Portfolio</h1>
        <p className="page-lede">
          Positions, cash, and P&amp;L maintained by the Portfolio Management Agent
          (workplan.md §6).
        </p>
      </div>

      <div className="stat-grid">
        <StatTile label="Unrealized P&L" value={`$${totalUnrealized.toLocaleString()}`} />
        <StatTile label="Long Positions" value={longs} />
        <StatTile label="Short Positions" value={shorts} />
        <StatTile label="Positions Tracked" value={positions.length} />
      </div>

      <Card title="Positions">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Asset</th>
              <th>Qty</th>
              <th>Avg Price</th>
              <th>Last</th>
              <th>Unrealized P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.symbol}>
                <td className="mono">{p.symbol}</td>
                <td>{p.asset}</td>
                <td className={p.qty < 0 ? 'side-sell' : 'side-buy'}>{p.qty}</td>
                <td>{p.avgPrice.toFixed(2)}</td>
                <td>{p.last.toFixed(2)}</td>
                <td className={p.unrealized >= 0 ? 'value-pos' : 'value-neg'}>
                  {p.unrealized >= 0 ? '+' : ''}
                  {p.unrealized.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
