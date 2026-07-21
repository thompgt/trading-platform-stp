import { useState } from 'react'
import { Card, StatTile } from '../components/ui.jsx'
import DonutChart from '../components/charts/DonutChart.jsx'
import BarChart from '../components/charts/BarChart.jsx'
import { positions as defaultPositions } from '../data/mockData.js'
import { askCopilot } from '../api/backend.js'

export function ExposureChart({ positions = [] }) {
  const items = positions.map((p) => ({ label: p.symbol, value: p.unrealized }))
  return (
    <BarChart
      items={items}
      formatValue={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}`}
      emptyLabel="No positions to chart."
    />
  )
}

/** Gross notional exposure per position — magnitude only, no polarity. */
export function GrossExposureChart({ positions = [] }) {
  const items = positions.map((p) => ({ label: p.symbol, value: Math.abs(p.qty * p.last) }))
  return (
    <BarChart
      items={items}
      toneFor={() => 'neutral'}
      formatValue={(v) => `$${Math.round(v).toLocaleString()}`}
      emptyLabel="No positions to chart."
    />
  )
}

/** Notional market value per asset class, for the allocation donut. */
export function allocationByAssetClass(positions) {
  const totals = new Map()
  for (const p of positions) {
    const notional = Math.abs(p.qty * p.last)
    totals.set(p.asset, (totals.get(p.asset) ?? 0) + notional)
  }
  return Array.from(totals, ([label, value]) => ({ label, value }))
}

/** Top-line KPIs summarizing the book — net P&L, gross exposure, position count, largest position. */
function portfolioKpis(positions) {
  const netPnl = positions.reduce((sum, p) => sum + p.unrealized, 0)
  const grossExposure = positions.reduce((sum, p) => sum + Math.abs(p.qty * p.last), 0)
  const largest = positions.reduce((max, p) => (Math.abs(p.qty * p.last) > Math.abs(max.qty * max.last) ? p : max), positions[0])
  return { netPnl, grossExposure, count: positions.length, largest }
}

export default function Reporting() {
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState(null)

  async function handleAsk(e) {
    e.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) return

    setAsking(true)
    setError(null)
    try {
      const facts = { positions: defaultPositions }
      const result = await askCopilot(trimmed, facts)
      setAnswer(result.answer)
    } catch (err) {
      setError(err.message || 'The copilot could not answer that question.')
      setAnswer(null)
    } finally {
      setAsking(false)
    }
  }

  const kpis = portfolioKpis(defaultPositions)

  return (
    <div className="page">
      <div className="page-head">
        <h1>Reporting &amp; Charting</h1>
        <p className="page-lede">
          Scheduled and ad hoc reports, plus an NL-query copilot over portfolio/risk data
          (workplan.md §6).
        </p>
      </div>

      <div className="stat-grid">
        <StatTile
          label="Net Unrealized P&amp;L"
          value={`${kpis.netPnl >= 0 ? '+' : ''}$${kpis.netPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          deltaTone={kpis.netPnl >= 0 ? 'tone-good' : 'tone-bad'}
        />
        <StatTile label="Gross Exposure" value={`$${Math.round(kpis.grossExposure).toLocaleString()}`} />
        <StatTile label="Open Positions" value={kpis.count} />
        <StatTile label="Largest Position" value={kpis.largest?.symbol ?? '—'} />
      </div>

      <div className="two-col">
        <Card title="Unrealized P&amp;L by Position">
          <ExposureChart positions={defaultPositions} />
        </Card>
        <Card title="Allocation by Asset Class" subtitle="Notional market value">
          <DonutChart data={allocationByAssetClass(defaultPositions)} />
        </Card>
      </div>

      <Card title="Gross Exposure by Position" subtitle="Absolute notional market value, largest first">
        <GrossExposureChart positions={defaultPositions} />
      </Card>

      <Card
        title="Ask the Research Copilot"
        subtitle="Backed by the Groq strategy/copilot agent — grounded only in the facts shown to it, never invented"
      >
        <form className="copilot-form" onSubmit={handleAsk}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. What's my largest position by unrealized P&L?"
            aria-label="Ask the research copilot"
          />
          <button type="submit" disabled={asking}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </form>
        {error && (
          <div className="copilot-answer copilot-error" role="alert">
            {error}
          </div>
        )}
        {answer && !error && (
          <div className="copilot-answer" role="status">
            {answer}
          </div>
        )}
      </Card>
    </div>
  )
}
