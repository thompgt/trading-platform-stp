import { Card, Badge } from '../components/ui.jsx'
import { orders } from '../data/mockData.js'

const STATUS_TONE = {
  FILLED: 'healthy',
  SETTLED: 'healthy',
  PARTIAL: 'warning',
  WORKING: 'warning',
  'PENDING RISK': 'medium',
  REJECTED: 'alert',
}

export default function OrderBlotter() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Order Blotter</h1>
        <p className="page-lede">
          Orders as they move through Order Intake → Pre-Trade Risk → Smart Order Router →
          Execution Management (workplan.md §3).
        </p>
      </div>

      <Card>
        <table className="data-table">
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Symbol</th>
              <th>Asset</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Type</th>
              <th>Venue</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="mono">{o.id}</td>
                <td>{o.symbol}</td>
                <td>{o.asset}</td>
                <td>
                  <span className={o.side === 'BUY' ? 'side-buy' : 'side-sell'}>{o.side}</span>
                </td>
                <td>{o.qty}</td>
                <td>{o.type}</td>
                <td>{o.venue}</td>
                <td>
                  <Badge status={STATUS_TONE[o.status] || 'neutral'}>{o.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
