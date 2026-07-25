import { useEffect, useState } from 'react'
import { Card, Badge, StatTile } from '../components/ui.jsx'
import Sparkline from '../components/charts/Sparkline.jsx'
import Meter from '../components/charts/Meter.jsx'
import { analyticsSignals } from '../data/mockData.js'
import { getSignals } from '../api/backend.js'

// Each indicator has its own units and typical range, so raw values aren't comparable
// across rows — index each to a 0-100% "how extreme is this reading" common base instead
// of plotting different-unit values on one shared scale. The backend computes this for
// live signals; this mirrors it for the mock rows shown when the backend is unreachable.
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

/** Direction the mock rows imply, so offline and live rows render through one code path. */
const MOCK_DIRECTION = {
  Overbought: 'bearish',
  'Bearish crossover': 'bearish',
  'Golden cross': 'bullish',
  'Near upper band': 'neutral',
}

export function mockSignalRows() {
  return analyticsSignals.map((s) => ({
    ...s,
    direction: MOCK_DIRECTION[s.signal] ?? 'neutral',
    strength: signalExtremity(s.indicator, s.value),
  }))
}

const BADGE_STATUS = { bullish: 'healthy', bearish: 'medium', neutral: 'low' }
const SPARK_TONE = { bullish: 'good', bearish: 'bad', neutral: 'neutral' }
const METER_TONE = { bullish: 'good', bearish: 'bad', neutral: 'warn' }

/** Indicator values span very different magnitudes — a ratio near 1, an RSI near 70. */
function formatValue(value) {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 100) return value.toFixed(0)
  if (Math.abs(value) >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

export function summarize(rows) {
  const bullish = rows.filter((r) => r.direction === 'bullish').length
  const bearish = rows.filter((r) => r.direction === 'bearish').length
  const avgStrength = rows.length > 0 ? rows.reduce((sum, r) => sum + r.strength, 0) / rows.length : 0
  return { bullish, bearish, avgStrength }
}

export default function Analytics() {
  const [rows, setRows] = useState([])
  const [skipped, setSkipped] = useState([])
  const [source, setSource] = useState('loading')

  useEffect(() => {
    let cancelled = false
    getSignals()
      .then((data) => {
        if (cancelled) return
        setRows(data.signals ?? [])
        setSkipped(data.skipped ?? [])
        // A reachable backend with nothing cached is a real, distinct state — say so
        // rather than quietly substituting sample data for it.
        setSource((data.signals ?? []).length > 0 ? 'live' : 'empty')
      })
      .catch(() => {
        if (cancelled) return
        setRows(mockSignalRows())
        setSkipped([])
        setSource('offline')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const { bullish, bearish, avgStrength } = summarize(rows)

  return (
    <div className="page">
      <div className="page-head">
        <h1>Technical Analytics</h1>
        <p className="page-lede">
          Indicator library and signal framework used by both the Technical Analytics
          Agent and the Strategy Generation Agent (workplan.md §6). Signals are computed
          deterministically from cached bars — no model is consulted.
        </p>
      </div>

      {source === 'offline' && (
        <Card className="error-banner">
          <strong>Backend unreachable</strong> — showing sample signals. Start the backend
          to compute signals from real bars.
        </Card>
      )}
      {source === 'empty' && (
        <Card>
          <strong>No market data cached yet.</strong> Fetch bars for a symbol on the Paper
          Trading page and these signals will populate from it.
        </Card>
      )}

      <div className="stat-grid">
        <StatTile label="Active Signals" value={rows.length} />
        <StatTile label="Bullish" value={bullish} deltaTone="tone-good" />
        <StatTile label="Bearish" value={bearish} deltaTone="tone-bad" />
        <StatTile label="Avg. Signal Strength" value={`${Math.round(avgStrength)}%`} />
      </div>

      <Card
        title="Active Signals"
        subtitle={source === 'live' ? 'Computed from cached bars in DuckDB' : undefined}
      >
        {rows.length === 0 ? (
          <p className="empty-state">No signals to show.</p>
        ) : (
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
              {rows.map((s, i) => (
                <tr key={`${s.symbol}-${s.indicator}-${i}`}>
                  <td className="mono">{s.symbol}</td>
                  <td title={s.detail}>{s.indicator}</td>
                  <td>
                    <Sparkline values={s.trend} tone={SPARK_TONE[s.direction] || 'neutral'} />
                  </td>
                  <td>{formatValue(s.value)}</td>
                  <td>
                    <Meter pct={s.strength} tone={METER_TONE[s.direction] || 'neutral'} />
                  </td>
                  <td>
                    <Badge status={BADGE_STATUS[s.direction] || 'low'}>{s.signal}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {skipped.length > 0 && (
        <Card
          title="Not enough history"
          subtitle="Indicators left out rather than recomputed over a shorter period than their name claims"
        >
          <table className="data-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Indicator</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {skipped.map((s, i) => (
                <tr key={`${s.symbol}-${s.indicator}-${i}`}>
                  <td className="mono">{s.symbol}</td>
                  <td>{s.indicator}</td>
                  <td className="empty-state">{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
