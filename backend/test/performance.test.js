import { describe, it, expect } from 'vitest'
import { computePerformance, inferPeriodsPerYear, roundTrips } from '../src/analytics/performance.js'

function curve(values, start = '2024-01-01') {
  const base = new Date(start)
  return values.map((equity, i) => {
    const ts = new Date(base)
    ts.setDate(ts.getDate() + i)
    return { ts: ts.toISOString(), equity }
  })
}

describe('roundTrips', () => {
  it('pairs each BUY with the SELL that closes it', () => {
    const closed = roundTrips([
      { ts: '2024-01-01', side: 'BUY', qty: 10, price: 100 },
      { ts: '2024-01-05', side: 'SELL', qty: 10, price: 110 },
      { ts: '2024-01-08', side: 'BUY', qty: 5, price: 120 },
      { ts: '2024-01-09', side: 'SELL', qty: 5, price: 100 },
    ])
    expect(closed).toHaveLength(2)
    expect(closed[0].pnl).toBeCloseTo(100)
    expect(closed[0].returnPct).toBeCloseTo(10)
    expect(closed[1].pnl).toBeCloseTo(-100)
  })

  it('ignores a still-open BUY at the end of the tape', () => {
    const closed = roundTrips([
      { ts: '2024-01-01', side: 'BUY', qty: 10, price: 100 },
      { ts: '2024-01-05', side: 'SELL', qty: 10, price: 110 },
      { ts: '2024-01-08', side: 'BUY', qty: 5, price: 120 },
    ])
    expect(closed).toHaveLength(1)
  })

  it('ignores a SELL with no matching open position', () => {
    expect(roundTrips([{ ts: '2024-01-01', side: 'SELL', qty: 10, price: 100 }])).toHaveLength(0)
  })
})

describe('inferPeriodsPerYear', () => {
  function series(count, stepMs) {
    const base = new Date('2024-01-02T14:30:00Z').getTime()
    return Array.from({ length: count }, (_, i) => ({ ts: new Date(base + i * stepMs).toISOString() }))
  }

  it('falls back to daily for a series too short to measure', () => {
    expect(inferPeriodsPerYear([])).toBe(252)
    expect(inferPeriodsPerYear([{ ts: '2024-01-01' }, { ts: '2024-01-02' }])).toBe(252)
  })

  it('recognizes daily bars', () => {
    expect(inferPeriodsPerYear(series(10, 24 * 60 * 60 * 1000))).toBe(252)
  })

  it('scales up for intraday bars', () => {
    // 78 five-minute bars in a 6.5-hour session.
    expect(inferPeriodsPerYear(series(20, 5 * 60 * 1000))).toBe(252 * 78)
    expect(inferPeriodsPerYear(series(20, 60 * 60 * 1000))).toBeCloseTo(252 * 6.5, 0)
  })

  it('scales down for weekly bars', () => {
    expect(inferPeriodsPerYear(series(10, 7 * 24 * 60 * 60 * 1000))).toBe(36)
  })

  it('uses the median so overnight gaps do not drag an intraday series toward daily', () => {
    const fiveMin = 5 * 60 * 1000
    const base = new Date('2024-01-02T14:30:00Z').getTime()
    const bars = []
    // Two sessions of 10 five-minute bars, separated by an 18-hour overnight gap.
    for (let day = 0; day < 2; day++) {
      for (let i = 0; i < 10; i++) {
        bars.push({ ts: new Date(base + day * 24 * 60 * 60 * 1000 + i * fiveMin).toISOString() })
      }
    }
    expect(inferPeriodsPerYear(bars)).toBe(252 * 78)
  })
})

describe('computePerformance', () => {
  it('returns a neutral summary for an empty session without dividing by zero', () => {
    const perf = computePerformance({ equityCurve: [], trades: [], startingCash: 100000 })
    expect(perf.totalPnl).toBe(0)
    expect(perf.totalReturnPct).toBe(0)
    expect(perf.maxDrawdownPct).toBe(0)
    expect(perf.sharpe).toBe(0)
    expect(perf.winRatePct).toBeNull()
    expect(perf.profitFactor).toBeNull()
    expect(perf.pnlCurve).toEqual([])
    expect(Number.isFinite(perf.exposurePct)).toBe(true)
  })

  it('computes P&L against starting cash, not against the first curve point', () => {
    const perf = computePerformance({
      equityCurve: curve([100000, 101000, 103000]),
      startingCash: 100000,
    })
    expect(perf.totalPnl).toBeCloseTo(3000)
    expect(perf.totalReturnPct).toBeCloseTo(3)
    expect(perf.finalEquity).toBeCloseTo(103000)
    expect(perf.pnlCurve.map((p) => p.pnl)).toEqual([0, 1000, 3000])
  })

  it('tracks max drawdown from the running peak and reports it as a positive percentage', () => {
    // Peak 120k, trough 90k -> 25% drawdown, then a partial recovery to 100k.
    const perf = computePerformance({
      equityCurve: curve([100000, 120000, 90000, 100000]),
      startingCash: 100000,
    })
    expect(perf.maxDrawdownPct).toBeCloseTo(25)
    expect(perf.maxDrawdownValue).toBeCloseTo(30000)
    // Still 20000 below the 120k peak at the end.
    expect(perf.currentDrawdownPct).toBeCloseTo(16.667, 2)
  })

  it('emits an underwater drawdown series that is zero at new highs and negative below them', () => {
    const perf = computePerformance({
      equityCurve: curve([100000, 110000, 99000]),
      startingCash: 100000,
    })
    expect(perf.drawdownCurve.map((d) => d.drawdown)).toEqual([0, 0, -10])
  })

  it('derives win rate and profit factor from closed round trips only', () => {
    const perf = computePerformance({
      equityCurve: curve([100000, 101000, 100500]),
      startingCash: 100000,
      trades: [
        { ts: '2024-01-01', side: 'BUY', qty: 10, price: 100 },
        { ts: '2024-01-02', side: 'SELL', qty: 10, price: 120 }, // +200
        { ts: '2024-01-03', side: 'BUY', qty: 10, price: 120 },
        { ts: '2024-01-04', side: 'SELL', qty: 10, price: 110 }, // -100
      ],
    })
    expect(perf.roundTripCount).toBe(2)
    expect(perf.winCount).toBe(1)
    expect(perf.lossCount).toBe(1)
    expect(perf.winRatePct).toBeCloseTo(50)
    expect(perf.profitFactor).toBeCloseTo(2)
    expect(perf.avgWin).toBeCloseTo(200)
    expect(perf.avgLoss).toBeCloseTo(-100)
    expect(perf.bestTradePct).toBeCloseTo(20)
  })

  it('leaves profit factor undefined when there are no losing trades', () => {
    const perf = computePerformance({
      equityCurve: curve([100000, 101000]),
      startingCash: 100000,
      trades: [
        { ts: '2024-01-01', side: 'BUY', qty: 10, price: 100 },
        { ts: '2024-01-02', side: 'SELL', qty: 10, price: 120 },
      ],
    })
    expect(perf.profitFactor).toBeNull()
    expect(perf.winRatePct).toBeCloseTo(100)
  })

  it('scores a steadily rising curve with a positive Sharpe and a flat one with zero', () => {
    const rising = computePerformance({ equityCurve: curve([100, 102, 104, 106, 108]) })
    expect(rising.sharpe).toBeGreaterThan(0)

    const flat = computePerformance({ equityCurve: curve([100, 100, 100, 100]) })
    expect(flat.sharpe).toBe(0)
    expect(flat.volatilityPct).toBe(0)
  })

  it('scales annualized figures by the bar size via periodsPerYear', () => {
    const values = [100, 102, 101, 104, 103]
    const daily = computePerformance({ equityCurve: curve(values), periodsPerYear: 252 })
    const intraday = computePerformance({ equityCurve: curve(values), periodsPerYear: 252 * 78 })
    expect(Math.abs(intraday.sharpe)).toBeGreaterThan(Math.abs(daily.sharpe))
  })

  it('measures exposure as the share of bars spent holding a position', () => {
    // 5 bars; held from bar 1 through bar 3 inclusive = 3/5.
    const perf = computePerformance({
      equityCurve: curve([100, 101, 102, 103, 104]),
      trades: [
        { ts: curve([0])[0].ts, side: 'BUY', qty: 1, price: 100 },
        { ts: curve([0, 0, 0])[2].ts, side: 'SELL', qty: 1, price: 102 },
      ],
    })
    expect(perf.exposurePct).toBeCloseTo(60)
  })

  it('counts a still-open position as held through the end of the curve', () => {
    const bars = curve([100, 101, 102, 103])
    const perf = computePerformance({
      equityCurve: bars,
      trades: [{ ts: bars[2].ts, side: 'BUY', qty: 1, price: 102 }],
    })
    expect(perf.exposurePct).toBeCloseTo(50)
  })
})
