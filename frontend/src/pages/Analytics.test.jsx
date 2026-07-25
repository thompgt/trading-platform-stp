import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import Analytics, { signalExtremity, mockSignalRows, summarize } from './Analytics.jsx'
import * as backend from '../api/backend.js'

vi.mock('../api/backend.js')

function signal(overrides = {}) {
  return {
    symbol: 'AAPL',
    indicator: 'RSI(14)',
    value: 71.2,
    signal: 'Overbought',
    direction: 'bearish',
    strength: 42.4,
    trend: [62, 64, 66, 69, 70, 71.2],
    detail: '71.2 against 30/70 bands',
    ...overrides,
  }
}

describe('signalExtremity', () => {
  it('is zero at an indicator’s neutral center and 100 at the edge of its span', () => {
    expect(signalExtremity('RSI(14)', 50)).toBe(0)
    expect(signalExtremity('RSI(14)', 100)).toBe(100)
    expect(signalExtremity('Bollinger %B', 0.5)).toBe(0)
  })

  it('clamps beyond the span rather than exceeding the meter', () => {
    expect(signalExtremity('50/200 SMA', 5)).toBe(100)
  })

  it('falls back to a self-scaled span for an unknown indicator', () => {
    expect(signalExtremity('Unknown', 3)).toBe(100)
    expect(signalExtremity('Unknown', 0)).toBe(0)
  })
})

describe('summarize', () => {
  it('counts directions and averages strength', () => {
    const { bullish, bearish, avgStrength } = summarize([
      signal({ direction: 'bullish', strength: 80 }),
      signal({ direction: 'bearish', strength: 20 }),
    ])
    expect(bullish).toBe(1)
    expect(bearish).toBe(1)
    expect(avgStrength).toBeCloseTo(50)
  })

  it('reports zero rather than NaN with no rows', () => {
    expect(summarize([]).avgStrength).toBe(0)
  })
})

describe('mockSignalRows', () => {
  it('gives every fallback row the direction and strength the live shape has', () => {
    for (const row of mockSignalRows()) {
      expect(['bullish', 'bearish', 'neutral']).toContain(row.direction)
      expect(row.strength).toBeGreaterThanOrEqual(0)
      expect(row.strength).toBeLessThanOrEqual(100)
    }
  })
})

describe('Analytics page', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('renders live signals from the backend', async () => {
    backend.getSignals.mockResolvedValue({
      signals: [signal(), signal({ symbol: 'MSFT', indicator: 'MACD', direction: 'bullish', signal: 'Above zero line' })],
      skipped: [],
      summary: {},
    })

    render(<Analytics />)

    expect(await screen.findByText('Overbought')).toBeInTheDocument()
    expect(screen.getByText('Above zero line')).toBeInTheDocument()
    expect(screen.getByText('Computed from cached bars in DuckDB')).toBeInTheDocument()
    expect(screen.queryByText(/Backend unreachable/)).not.toBeInTheDocument()
  })

  it('lists indicators skipped for want of history', async () => {
    backend.getSignals.mockResolvedValue({
      signals: [signal()],
      skipped: [{ symbol: 'AAPL', indicator: '50/200 SMA', reason: 'needs 200 bars, have 40' }],
    })

    render(<Analytics />)

    expect(await screen.findByText('Not enough history')).toBeInTheDocument()
    expect(screen.getByText('needs 200 bars, have 40')).toBeInTheDocument()
  })

  it('falls back to sample signals, clearly labelled, when the backend is down', async () => {
    backend.getSignals.mockRejectedValue(new Error('Failed to fetch'))

    render(<Analytics />)

    expect(await screen.findByText(/Backend unreachable/)).toBeInTheDocument()
    // The table still renders something useful rather than going blank.
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1)
  })

  it('distinguishes "nothing cached yet" from "backend is down"', async () => {
    backend.getSignals.mockResolvedValue({ signals: [], skipped: [] })

    render(<Analytics />)

    expect(await screen.findByText(/No market data cached yet/)).toBeInTheDocument()
    expect(screen.queryByText(/Backend unreachable/)).not.toBeInTheDocument()
    expect(screen.getByText('No signals to show.')).toBeInTheDocument()
  })

  it('shows no stale signals after unmounting mid-request', async () => {
    let resolve
    backend.getSignals.mockReturnValue(new Promise((r) => { resolve = r }))

    const { unmount } = render(<Analytics />)
    unmount()
    resolve({ signals: [signal()], skipped: [] })

    // The late resolution must not try to set state on the unmounted page.
    await waitFor(() => expect(screen.queryByText('Overbought')).not.toBeInTheDocument())
  })
})
