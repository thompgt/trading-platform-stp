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

/** A zeroed performance payload — the shape the page gets before anything has happened. */
const emptyPerformance = {
  totalPnl: 0,
  totalReturnPct: 0,
  maxDrawdownPct: 0,
  currentDrawdownPct: 0,
  volatilityPct: 0,
  sharpe: 0,
  sortino: 0,
  tradeCount: 0,
  roundTripCount: 0,
  winCount: 0,
  lossCount: 0,
  winRatePct: null,
  profitFactor: null,
  bestTradePct: null,
  worstTradePct: null,
  exposurePct: 0,
  barsElapsed: 0,
  pnlCurve: [],
  drawdownCurve: [],
  closedTrades: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  // The page polls performance whenever the replay position moves, so every test that
  // starts a session needs this stubbed or the effect rejects on an undefined promise.
  backend.getSessionPerformance.mockResolvedValue({
    sessionId: 'sess-1',
    symbol: 'AAPL',
    performance: emptyPerformance,
  })
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

  describe('performance section', () => {
    const startedSession = {
      sessionId: 'sess-1',
      symbol: 'AAPL',
      cursor: 2,
      length: 2,
      isAtEnd: true,
      currentBar: sampleBars[1],
      trades: [],
      equityCurve: [{ ts: sampleBars[0].ts, equity: 100000 }],
      cash: 100000,
      position: 0,
    }

    /**
     * Read a stat tile by its label. Necessary because the chart axis labels format
     * values identically, so a bare getByText('+$12,500') matches both the tile and a
     * gridline label.
     */
    function tile(label) {
      const el = screen.getByText(label).closest('.stat-tile')
      return {
        value: el.querySelector('.stat-tile-value')?.textContent,
        delta: el.querySelector('.stat-tile-delta')?.textContent,
      }
    }

    async function startWithPerformance(performance) {
      backend.getBars.mockResolvedValue({ symbol: 'AAPL', bars: sampleBars })
      backend.startSimulation.mockResolvedValue(startedSession)
      backend.getSessionPerformance.mockResolvedValue({
        sessionId: 'sess-1',
        symbol: 'AAPL',
        performance: { ...emptyPerformance, ...performance },
      })
      const user = userEvent.setup()
      render(<PaperTrading />)
      await user.click(screen.getByRole('button', { name: 'Start Simulation' }))
      return user
    }

    it('stays hidden until the replay has produced at least one bar', async () => {
      await startWithPerformance({ barsElapsed: 0 })
      await screen.findByText('2 / 2')
      expect(screen.queryByText('Total P&L')).not.toBeInTheDocument()
    })

    it('renders P&L, drawdown, and risk-adjusted tiles once there is history', async () => {
      await startWithPerformance({
        barsElapsed: 20,
        totalPnl: 12500,
        totalReturnPct: 12.5,
        maxDrawdownPct: 8.25,
        currentDrawdownPct: 3.1,
        sharpe: 1.42,
        sortino: 2.03,
        volatilityPct: 18.4,
        exposurePct: 64.5,
        winRatePct: 66.67,
        profitFactor: 2.5,
        winCount: 2,
        lossCount: 1,
        roundTripCount: 3,
        bestTradePct: 9.4,
        worstTradePct: -3.2,
        pnlCurve: [
          { ts: sampleBars[0].ts, pnl: 0, equity: 100000 },
          { ts: sampleBars[1].ts, pnl: 12500, equity: 112500 },
        ],
        drawdownCurve: [
          { ts: sampleBars[0].ts, drawdown: 0 },
          { ts: sampleBars[1].ts, drawdown: -3.1 },
        ],
      })

      await screen.findByText('Total P&L')
      expect(tile('Total P&L')).toEqual({ value: '+$12,500', delta: '+12.50%' })
      expect(tile('Max Drawdown')).toEqual({ value: '8.25%', delta: 'now 3.10%' })
      expect(tile('Sharpe')).toEqual({ value: '1.42', delta: 'Sortino 2.03' })
      expect(tile('Volatility').value).toBe('18.40%')
      expect(tile('Win Rate')).toEqual({ value: '66.67%', delta: '2W / 1L' })
      expect(tile('Profit Factor')).toEqual({ value: '2.50', delta: '3 round trips' })
      expect(tile('Exposure').value).toBe('64.50%')
      expect(tile('Best / Worst Trade').value).toBe('+9.40% / -3.20%')
    })

    it('formats a losing session with a leading minus rather than a stray plus', async () => {
      await startWithPerformance({ barsElapsed: 20, totalPnl: -4200, totalReturnPct: -4.2 })
      await screen.findByText('Total P&L')
      expect(tile('Total P&L')).toEqual({ value: '-$4,200', delta: '-4.20%' })
    })

    it('dashes out win rate and profit factor before any trade has closed', async () => {
      await startWithPerformance({
        barsElapsed: 20,
        winRatePct: null,
        profitFactor: null,
        bestTradePct: null,
        worstTradePct: null,
      })
      await screen.findByText('Win Rate')
      // Three dashes: win rate, profit factor, and the combined best/worst tile.
      expect(screen.getAllByText('—')).toHaveLength(2)
      expect(screen.getByText('— / —')).toBeInTheDocument()
    })

    it('refetches performance when the replay position moves', async () => {
      backend.getBars.mockResolvedValue({ symbol: 'AAPL', bars: sampleBars })
      backend.startSimulation.mockResolvedValue({ ...startedSession, cursor: 0, isAtEnd: false })
      backend.stepSimulation.mockResolvedValue({ ...startedSession, cursor: 1, isAtEnd: false })

      const user = userEvent.setup()
      render(<PaperTrading />)
      await user.click(screen.getByRole('button', { name: 'Start Simulation' }))
      await screen.findByText('0 / 2')
      await waitFor(() => expect(backend.getSessionPerformance).toHaveBeenCalledWith('sess-1'))
      const callsAfterStart = backend.getSessionPerformance.mock.calls.length

      await user.click(screen.getByRole('button', { name: /Step/ }))
      await screen.findByText('1 / 2')

      await waitFor(() =>
        expect(backend.getSessionPerformance.mock.calls.length).toBeGreaterThan(callsAfterStart),
      )
    })

    it('keeps the simulation usable when the performance endpoint fails', async () => {
      backend.getBars.mockResolvedValue({ symbol: 'AAPL', bars: sampleBars })
      backend.startSimulation.mockResolvedValue(startedSession)
      backend.getSessionPerformance.mockRejectedValue(new Error('performance unavailable'))

      const user = userEvent.setup()
      render(<PaperTrading />)
      await user.click(screen.getByRole('button', { name: 'Start Simulation' }))

      // Simulation still renders, and the failure is not promoted to the error banner.
      expect(await screen.findByText('2 / 2')).toBeInTheDocument()
      await waitFor(() => expect(backend.getSessionPerformance).toHaveBeenCalled())
      expect(screen.queryByText(/performance unavailable/)).not.toBeInTheDocument()
    })
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
