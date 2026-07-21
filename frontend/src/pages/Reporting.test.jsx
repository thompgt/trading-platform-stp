import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExposureChart, allocationByAssetClass } from './Reporting.jsx'
import * as backend from '../api/backend.js'

vi.mock('../api/backend.js')

beforeEach(() => {
  vi.clearAllMocks()
})

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

describe('allocationByAssetClass', () => {
  it('sums notional value (|qty * last|) grouped by asset class', () => {
    const result = allocationByAssetClass([
      { symbol: 'AAPL', qty: 10, last: 100, asset: 'Equity' },
      { symbol: 'NVDA', qty: 5, last: 100, asset: 'Equity' },
      { symbol: 'ES FUT', qty: -2, last: 100, asset: 'Future' },
    ])
    expect(result).toEqual(
      expect.arrayContaining([
        { label: 'Equity', value: 1500 },
        { label: 'Future', value: 200 },
      ]),
    )
  })

  it('returns an empty array for an empty portfolio instead of throwing', () => {
    expect(allocationByAssetClass([])).toEqual([])
  })
})

describe('Reporting copilot form', () => {
  it('ignores submissions with an empty query', async () => {
    const { default: Reporting } = await import('./Reporting.jsx')
    render(<Reporting />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ask' }))
    expect(backend.askCopilot).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows the backend-grounded answer after asking a question', async () => {
    backend.askCopilot.mockResolvedValue({ answer: 'AAPL is your largest position.', usedFacts: [] })
    const { default: Reporting } = await import('./Reporting.jsx')
    const user = userEvent.setup()
    render(<Reporting />)

    await user.type(screen.getByLabelText('Ask the research copilot'), "What's my largest position?")
    await user.click(screen.getByRole('button', { name: 'Ask' }))

    expect(await screen.findByRole('status')).toHaveTextContent('AAPL is your largest position.')
  })

  it('shows an error instead of crashing when the copilot backend call fails', async () => {
    backend.askCopilot.mockRejectedValue(new Error('LLM did not return valid JSON after 3 attempts'))
    const { default: Reporting } = await import('./Reporting.jsx')
    const user = userEvent.setup()
    render(<Reporting />)

    await user.type(screen.getByLabelText('Ask the research copilot'), 'anything?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not return valid JSON/)
  })
})
