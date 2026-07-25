import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import BarChart from './BarChart.jsx'

const items = [
  { label: 'AAPL', value: 7170 },
  { label: 'MSFT', value: -688 },
]

describe('BarChart', () => {
  it('renders the empty label when there is nothing to plot', () => {
    render(<BarChart items={[]} emptyLabel="No requests recorded yet." />)
    expect(screen.getByText('No requests recorded yet.')).toBeInTheDocument()
  })

  it('scales each bar against the largest absolute value', () => {
    const { container } = render(<BarChart items={items} />)
    const fills = [...container.querySelectorAll('.bar-fill')]
    expect(fills[0].style.width).toBe('100%')
    // 688 / 7170 ≈ 10%
    expect(fills[1].style.width).toBe('10%')
  })

  it('tones bars by sign unless told otherwise', () => {
    const { container } = render(<BarChart items={items} />)
    expect(container.querySelector('.bar-pos')).not.toBeNull()
    expect(container.querySelector('.bar-neg')).not.toBeNull()
  })

  it('accepts a constant tone for magnitude-only charts', () => {
    const { container } = render(<BarChart items={items} toneFor={() => 'neutral'} />)
    expect(container.querySelectorAll('.bar-accent')).toHaveLength(2)
    expect(container.querySelector('.bar-neg')).toBeNull()
  })

  it('does not divide by zero when every value is zero', () => {
    const { container } = render(<BarChart items={[{ label: 'FLAT', value: 0 }]} />)
    expect(container.querySelector('.bar-fill').style.width).toBe('0%')
  })

  it('widens the label column on request, for labels that do not fit the default', () => {
    // Route patterns are far longer than a ticker; without this the label overflows
    // across the bar track beside it.
    const { container } = render(
      <BarChart items={[{ label: '/api/simulation/:id/step', value: 300 }]} labelWidth="260px" />,
    )
    expect(container.querySelector('.bar-chart').style.getPropertyValue('--bar-label-width')).toBe('260px')
  })

  it('leaves the label width unset when not specified', () => {
    const { container } = render(<BarChart items={items} />)
    expect(container.querySelector('.bar-chart').style.getPropertyValue('--bar-label-width')).toBe('')
  })
})
