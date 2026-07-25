import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import LineSeriesChart from './LineSeriesChart.jsx'

const data = [
  { ts: '2024-01-01', close: 100 },
  { ts: '2024-01-02', close: 105 },
  { ts: '2024-01-03', close: 98 },
]

describe('LineSeriesChart', () => {
  it('shows an empty state instead of crashing with no data', () => {
    render(<LineSeriesChart data={[]} yKey="close" />)
    expect(screen.getByText('No data yet.')).toBeInTheDocument()
  })

  it('renders a single accessible chart element for the series', () => {
    render(<LineSeriesChart data={data} yKey="close" />)
    expect(screen.getByRole('img', { name: /close over time chart/i })).toBeInTheDocument()
  })

  it('handles a single data point without dividing by zero', () => {
    render(<LineSeriesChart data={[{ ts: '2024-01-01', close: 100 }]} yKey="close" />)
    expect(screen.getByRole('img')).toBeInTheDocument()
  })

  it('handles a flat series (min === max) without producing NaN geometry', () => {
    const flat = [
      { ts: '2024-01-01', close: 50 },
      { ts: '2024-01-02', close: 50 },
    ]
    const { container } = render(<LineSeriesChart data={flat} yKey="close" />)
    const path = container.querySelector('path[stroke]')
    expect(path.getAttribute('d')).not.toMatch(/NaN/)
  })

  describe('reference line', () => {
    it('is absent unless a referenceValue is given', () => {
      const { container } = render(<LineSeriesChart data={data} yKey="close" />)
      expect(container.querySelector('.chart-reference-line')).toBeNull()
    })

    it('draws a baseline and stretches the domain to include it', () => {
      // An all-positive P&L series: without the reference the axis would start at 500 and
      // the chart would imply breakeven sits at its own minimum.
      const pnl = [
        { ts: '2024-01-01', pnl: 500 },
        { ts: '2024-01-02', pnl: 1500 },
      ]
      const { container } = render(<LineSeriesChart data={pnl} yKey="pnl" referenceValue={0} />)

      const line = container.querySelector('.chart-reference-line')
      expect(line).not.toBeNull()
      // Zero is now the domain floor, so the baseline sits at the bottom of the plot.
      const labels = [...container.querySelectorAll('.chart-axis-label')].map((n) => n.textContent)
      expect(labels).toContain('0.00')
    })

    it('places the baseline inside the plot when the series straddles it', () => {
      const pnl = [
        { ts: '2024-01-01', pnl: -1000 },
        { ts: '2024-01-02', pnl: 1000 },
      ]
      const { container } = render(<LineSeriesChart data={pnl} yKey="pnl" referenceValue={0} />)
      const line = container.querySelector('.chart-reference-line')
      const y = Number(line.getAttribute('y1'))
      expect(Number.isNaN(y)).toBe(false)
      // Symmetric range, so zero lands at the vertical midpoint of the plot area.
      expect(y).toBeCloseTo(12 + (220 - 12 - 24) / 2, 0)
    })

    it('does not produce NaN geometry when the reference equals a flat series', () => {
      const flat = [
        { ts: '2024-01-01', pnl: 0 },
        { ts: '2024-01-02', pnl: 0 },
      ]
      const { container } = render(<LineSeriesChart data={flat} yKey="pnl" referenceValue={0} />)
      const line = container.querySelector('.chart-reference-line')
      expect(line.getAttribute('y1')).not.toMatch(/NaN/)
    })
  })

  it('only plots markers whose timestamp matches a bar in the series', () => {
    const { container } = render(
      <LineSeriesChart
        data={data}
        yKey="close"
        markers={[
          { ts: '2024-01-02', side: 'BUY' },
          { ts: '2099-01-01', side: 'SELL' }, // no matching bar — must be silently dropped
        ]}
      />,
    )
    const markers = container.querySelectorAll('.chart-marker-buy, .chart-marker-sell')
    expect(markers).toHaveLength(1)
  })
})
