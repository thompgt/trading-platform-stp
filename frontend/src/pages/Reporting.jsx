import { useState } from 'react'
import { Card } from '../components/ui.jsx'
import DonutChart from '../components/charts/DonutChart.jsx'
import { positions as defaultPositions } from '../data/mockData.js'
import { askCopilot } from '../api/backend.js'

export function ExposureChart({ positions = [] }) {
  if (positions.length === 0) {
    return <p className="empty-state">No positions to chart.</p>
  }

  const max = Math.max(...positions.map((p) => Math.abs(p.unrealized)), 0)

  return (
    <div className="bar-chart">
      {positions.map((p) => {
        const pct = max === 0 ? 0 : Math.round((Math.abs(p.unrealized) / max) * 100)
        return (
          <div className="bar-row" key={p.symbol}>
            <span className="bar-label mono">{p.symbol}</span>
            <div className="bar-track">
              <div
                className={p.unrealized >= 0 ? 'bar-fill bar-pos' : 'bar-fill bar-neg'}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={p.unrealized >= 0 ? 'value-pos bar-value' : 'value-neg bar-value'}>
              {p.unrealized >= 0 ? '+' : ''}
              {p.unrealized.toFixed(0)}
            </span>
          </div>
        )
      })}
    </div>
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

  return (
    <div className="page">
      <div className="page-head">
        <h1>Reporting &amp; Charting</h1>
        <p className="page-lede">
          Scheduled and ad hoc reports, plus an NL-query copilot over portfolio/risk data
          (workplan.md §6).
        </p>
      </div>

      <div className="two-col">
        <Card title="Unrealized P&amp;L by Position">
          <ExposureChart positions={defaultPositions} />
        </Card>
        <Card title="Allocation by Asset Class" subtitle="Notional market value">
          <DonutChart data={allocationByAssetClass(defaultPositions)} />
        </Card>
      </div>

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
