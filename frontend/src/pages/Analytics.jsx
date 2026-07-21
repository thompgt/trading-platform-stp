import { Card, Badge, StatTile } from '../components/ui.jsx'
import Sparkline from '../components/charts/Sparkline.jsx'
import Meter from '../components/charts/Meter.jsx'
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

const METER_TONE = {
  Overbought: 'bad',
  'Bearish crossover': 'bad',
  'Golden cross': 'good',
  'Near upper band': 'warn',
}

// Each indicator has its own units and typical range, so raw values aren't comparable
// across rows — index each to a 0-100% "how extreme is this reading" common base instead
// of plotting different-unit values on one shared scale.
const EXTREMITY_BOUNDS = {
  'RSI(14)': { center: 50, span: 50 },
  MACD: { center: 0, span: 1 },
  '50/200 SMA': { center: 1, span: 0.2 },
  'Bollinger %B': { center: 0.5, span: 0.5 },
}

export function signalExtremity(indicator, value) {
  const bounds = EXTREMITY_BOUNDS[indicator] ?? { center: 0, span: Math.abs(value) || 1 }
  const pct = (Math.abs(value - bounds.center) / bounds.span) * 100
  return Math.max(0, Math.min(100, pct))
}

export default function Analytics() {
  const bullish = analyticsSignals.filter((s) => SPARK_TONE[s.signal] === 'good').length
  const bearish = analyticsSignals.filter((s) => SPARK_TONE[s.signal] === 'bad').length
  const avgExtremity =
    analyticsSignals.reduce((sum, s) => sum + signalExtremity(s.indicator, s.value), 0) / (analyticsSignals.length || 1)

  return (
    <div className="page">
      <div className="page-head">
        <h1>Technical Analytics</h1>
        <p className="page-lede">
          Indicator library and signal framework used by both the Technical Analytics
          Agent and the Strategy Generation Agent (workplan.md §6).
        </p>
      </div>

      <div className="stat-grid">
        <StatTile label="Active Signals" value={analyticsSignals.length} />
        <StatTile label="Bullish" value={bullish} deltaTone="tone-good" />
        <StatTile label="Bearish" value={bearish} deltaTone="tone-bad" />
        <StatTile label="Avg. Signal Strength" value={`${Math.round(avgExtremity)}%`} />
      </div>

      <Card title="Active Signals">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Indicator</th>
              <th>Trend</th>
              <th>Value</th>
              <th>Strength</th>
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
                  <Meter pct={signalExtremity(s.indicator, s.value)} tone={METER_TONE[s.signal] || 'neutral'} />
                </td>
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
