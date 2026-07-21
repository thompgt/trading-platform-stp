import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ExposureChart, answerCopilotQuery } from './Reporting.jsx'

describe('ExposureChart', () => {
  it('shows an empty state instead of crashing when there are no positions', () => {
    render(<ExposureChart positions={[]} />)
    expect(screen.getByText('No positions to chart.')).toBeInTheDocument()
  })

  it('does not divide by zero when every position has $0 unrealized P&L', () => {
    render(<ExposureChart positions={[{ symbol: 'FLAT', unrealized: 0 }]} />)
    expect(screen.getByText('FLAT')).toBeInTheDocument()
  })

  it('renders a bar per position', () => {
    render(
      <ExposureChart
        positions={[
          { symbol: 'AAPL', unrealized: 100 },
          { symbol: 'MSFT', unrealized: -50 },
        ]}
      />,
    )
    expect(screen.getByText('AAPL')).toBeInTheDocument()
    expect(screen.getByText('MSFT')).toBeInTheDocument()
  })
})

describe('answerCopilotQuery', () => {
  it('returns null for a blank query instead of answering', () => {
    expect(answerCopilotQuery('   ', [{ symbol: 'AAPL', unrealized: 10 }])).toBeNull()
  })

  it('handles an empty portfolio without throwing', () => {
    const answer = answerCopilotQuery('largest position?', [])
    expect(answer).toMatch(/no positions/i)
  })

  it('identifies the largest unrealized P&L contributor', () => {
    const positions = [
      { symbol: 'AAPL', unrealized: 100 },
      { symbol: 'MSFT', unrealized: 500 },
      { symbol: 'TSLA', unrealized: -900 },
    ]
    const answer = answerCopilotQuery('largest position?', positions)
    expect(answer).toContain('MSFT')
  })
})

describe('Reporting copilot form', () => {
  it('ignores submissions with an empty query', async () => {
    const { default: Reporting } = await import('./Reporting.jsx')
    render(<Reporting />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows an answer after asking a question', async () => {
    const { default: Reporting } = await import('./Reporting.jsx')
    render(<Reporting />)
    fireEvent.change(screen.getByLabelText('Ask the research copilot'), {
      target: { value: "What's my largest position?" },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
