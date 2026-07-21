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
