import { Card, Badge } from '../components/ui.jsx'
import Sparkline from '../components/charts/Sparkline.jsx'
import { analyticsSignals } from '../data/mockData.js'

const SIGNAL_TONE = {
  Overbought: 'medium',
  'Bearish crossover': 'medium',
  'Golden cross': 'healthy',
  'Near upper band': 'low',
}

const SPARK_TONE = {
  Overbought: 'bad',
  'Bearish crossover': 'bad',
  'Golden cross': 'good',
  'Near upper band': 'neutral',
}

export default function Analytics() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Technical Analytics</h1>
        <p className="page-lede">
          Indicator library and signal framework used by both the Technical Analytics
          Agent and the Strategy Generation Agent (workplan.md §6).
        </p>
      </div>

      <Card title="Active Signals">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Indicator</th>
              <th>Trend</th>
              <th>Value</th>
              <th>Signal</th>
            </tr>
          </thead>
          <tbody>
            {analyticsSignals.map((s, i) => (
              <tr key={i}>
                <td className="mono">{s.symbol}</td>
                <td>{s.indicator}</td>
                <td>
                  <Sparkline values={s.trend} tone={SPARK_TONE[s.signal] || 'neutral'} />
                </td>
                <td>{s.value}</td>
                <td>
                  <Badge status={SIGNAL_TONE[s.signal] || 'neutral'}>{s.signal}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
