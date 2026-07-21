import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PaperTrading from './PaperTrading.jsx'
import * as backend from '../api/backend.js'

vi.mock('../api/backend.js')

const sampleBars = [
  { symbol: 'AAPL', ts: '2024-01-01', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
  { symbol: 'AAPL', ts: '2024-01-02', open: 100, high: 102, low: 99, close: 101, volume: 1200 },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PaperTrading page', () => {
  it('fetches market data and shows the stored bar count', async () => {
    backend.fetchMarketData.mockResolvedValue({ symbol: 'AAPL', storedBars: 128 })
    const user = userEvent.setup()
    render(<PaperTrading />)

    await user.click(screen.getByRole('button', { name: 'Fetch Data' }))

    expect(await screen.findByText(/Stored 128 bars for AAPL/)).toBeInTheDocument()
  })

  it('shows an error banner instead of crashing when fetching data fails', async () => {
    backend.fetchMarketData.mockRejectedValue(new Error('No data returned for XYZ'))
    const user = userEvent.setup()
    render(<PaperTrading />)

    await user.click(screen.getByRole('button', { name: 'Fetch Data' }))

    expect(await screen.findByText(/No data returned for XYZ/)).toBeInTheDocument()
  })

  it('starts a simulation and renders stats once bars + session come back', async () => {
    backend.getBars.mockResolvedValue({ symbol: 'AAPL', bars: sampleBars })
    backend.startSimulation.mockResolvedValue({
      sessionId: 'sess-1',
      symbol: 'AAPL',
      cursor: 0,
      length: 2,
      isAtEnd: false,
      currentBar: null,
      trades: [],
      equityCurve: [],
      cash: 100000,
      position: 0,
    })
    const user = userEvent.setup()
    render(<PaperTrading />)

    await user.click(screen.getByRole('button', { name: 'Start Simulation' }))

    expect(await screen.findByText('0 / 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Play/ })).toBeInTheDocument()
  })

  it('steps the simulation forward and reflects the new cursor', async () => {
    backend.getBars.mockResolvedValue({ symbol: 'AAPL', bars: sampleBars })
    backend.startSimulation.mockResolvedValue({
      sessionId: 'sess-1',
      symbol: 'AAPL',
      cursor: 0,
      length: 2,
      isAtEnd: false,
      currentBar: null,
      trades: [],
      equityCurve: [],
      cash: 100000,
      position: 0,
    })
    backend.stepSimulation.mockResolvedValue({
      sessionId: 'sess-1',
      symbol: 'AAPL',
      cursor: 1,
      length: 2,
      isAtEnd: false,
      currentBar: sampleBars[0],
      trades: [],
      equityCurve: [{ ts: sampleBars[0].ts, equity: 100000 }],
      cash: 100000,
      position: 0,
    })

    const user = userEvent.setup()
    render(<PaperTrading />)
    await user.click(screen.getByRole('button', { name: 'Start Simulation' }))
    await screen.findByText('0 / 2')

    await user.click(screen.getByRole('button', { name: /Step/ }))

    expect(await screen.findByText('1 / 2')).toBeInTheDocument()
    expect(backend.stepSimulation).toHaveBeenCalledWith('sess-1', 1)
  })

  it('generates a strategy via the AI agent and shows the rationale', async () => {
    backend.generateStrategy.mockResolvedValue({
      strategy: {
        name: 'Trend Follower',
        rationale: 'Captures medium-term momentum using a fast/slow SMA cross.',
        kind: 'sma_crossover',
        params: { fastPeriod: 8, slowPeriod: 21 },
      },
      attempts: 1,
    })
    const user = userEvent.setup()
    render(<PaperTrading />)

    await user.click(screen.getByRole('button', { name: /Generate with AI/ }))

    expect(await screen.findByText(/Trend Follower/)).toBeInTheDocument()
    expect(screen.getByText(/Captures medium-term momentum/)).toBeInTheDocument()
  })

  it('surfaces an error banner instead of crashing when the AI agent fails validation', async () => {
    backend.generateStrategy.mockRejectedValue(new Error('LLM did not return valid JSON after 3 attempts'))
    const user = userEvent.setup()
    render(<PaperTrading />)

    await user.click(screen.getByRole('button', { name: /Generate with AI/ }))

    expect(await screen.findByText(/did not return valid JSON/)).toBeInTheDocument()
  })
})
