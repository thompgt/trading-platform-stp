import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import DonutChart from './DonutChart.jsx'

describe('DonutChart', () => {
  it('shows an empty state instead of crashing with no data', () => {
    render(<DonutChart data={[]} />)
    expect(screen.getByText('No allocation data.')).toBeInTheDocument()
  })

  it('computes percentage shares from the values given', () => {
    render(
      <DonutChart
        data={[
          { label: 'Equity', value: 75 },
          { label: 'Option', value: 25 },
        ]}
      />,
    )
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
  })

  it('does not divide by zero when every value is 0', () => {
    render(
      <DonutChart
        data={[
          { label: 'Equity', value: 0 },
          { label: 'Option', value: 0 },
        ]}
      />,
    )
    expect(screen.getAllByText('0%')).toHaveLength(2)
  })

  it('caps rendering at 3 categories and warns instead of adding a 4th hue', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(
      <DonutChart
        data={[
          { label: 'A', value: 10 },
          { label: 'B', value: 10 },
          { label: 'C', value: 10 },
          { label: 'D', value: 10 },
        ]}
      />,
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
