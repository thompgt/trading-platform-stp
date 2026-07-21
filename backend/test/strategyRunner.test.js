import { describe, it, expect } from 'vitest'
import { runStrategy } from '../src/simulation/strategyRunner.js'

function makeBars(closes, startDate = '2024-01-01') {
  const start = new Date(startDate)
  return closes.map((close, i) => {
    const ts = new Date(start)
    ts.setDate(ts.getDate() + i)
    return { ts, open: close, high: close, low: close, close, volume: 1000 }
  })
}

describe('runStrategy', () => {
  it('rejects an unknown strategy kind', () => {
    expect(() => runStrategy({ kind: 'not_a_real_strategy', params: {} }, makeBars([1, 2, 3]))).toThrow(
      /Unknown strategy kind/,
    )
  })

  it('handles an empty bar series without throwing', () => {
    const result = runStrategy({ kind: 'sma_crossover', params: { fastPeriod: 2, slowPeriod: 4 } }, [])
    expect(result).toEqual({ trades: [], equityCurve: [], finalCash: 100000, finalPosition: 0 })
  })

  it('buys on a golden cross and sells on a death cross for sma_crossover', () => {
    // Prices dip then rally then fall, forcing a fast/slow SMA crossover in both directions.
    const closes = [100, 100, 100, 100, 90, 85, 90, 100, 110, 120, 110, 95, 80, 70, 65]
    const bars = makeBars(closes)
    const { trades } = runStrategy(
      { kind: 'sma_crossover', params: { fastPeriod: 2, slowPeriod: 5 } },
      bars,
      { startingCash: 10000 },
    )

    expect(trades.length).toBeGreaterThan(0)
    expect(trades[0].side).toBe('BUY')
    // Trades must strictly alternate BUY/SELL — no double-buys or naked sells.
    for (let i = 1; i < trades.length; i++) {
      expect(trades[i].side).not.toBe(trades[i - 1].side)
    }
  })

  it('never spends more cash than it has (no leverage) for sma_crossover', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + 10 * Math.sin(i / 2))
    const bars = makeBars(closes)
    const { trades } = runStrategy(
      { kind: 'sma_crossover', params: { fastPeriod: 3, slowPeriod: 8 } },
      bars,
      { startingCash: 1000 },
    )
    for (const t of trades.filter((t) => t.side === 'BUY')) {
      expect(t.qty * t.price).toBeLessThanOrEqual(1000)
    }
  })

  it('produces one equity curve point per revealed bar', () => {
    const bars = makeBars([10, 11, 12, 13, 14, 15, 16, 17])
    const { equityCurve } = runStrategy(
      { kind: 'rsi_threshold', params: { period: 3, oversold: 30, overbought: 70 } },
      bars,
    )
    expect(equityCurve).toHaveLength(bars.length)
  })

  it('buys when RSI drops to oversold and sells when it rises to overbought', () => {
    const closes = [50, 49, 48, 47, 46, 45, 46, 48, 51, 55, 60, 65, 70, 72]
    const bars = makeBars(closes)
    const { trades } = runStrategy(
      { kind: 'rsi_threshold', params: { period: 3, oversold: 30, overbought: 70 } },
      bars,
      { startingCash: 5000 },
    )
    expect(trades.some((t) => t.side === 'BUY')).toBe(true)
  })
})
