import { describe, it, expect } from 'vitest'
import {
  smaSeries,
  emaSeries,
  rsiSeries,
  macdSeries,
  bollingerSeries,
  atrSeries,
  latest,
  tail,
} from '../src/analytics/indicators.js'

describe('smaSeries', () => {
  it('nulls the warm-up window and averages the trailing period after it', () => {
    expect(smaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it('returns an all-null series when there is less data than the period', () => {
    expect(smaSeries([1, 2], 5)).toEqual([null, null])
  })

  it('rejects a non-positive period rather than dividing by zero', () => {
    expect(smaSeries([1, 2, 3], 0)).toEqual([null, null, null])
  })
})

describe('emaSeries', () => {
  it('seeds with the SMA of the first period, then applies the multiplier', () => {
    const out = emaSeries([1, 2, 3, 4, 5], 3)
    expect(out.slice(0, 2)).toEqual([null, null])
    expect(out[2]).toBeCloseTo(2) // SMA(1,2,3)
    expect(out[3]).toBeCloseTo(3) // (4 - 2) * 0.5 + 2
    expect(out[4]).toBeCloseTo(4) // (5 - 3) * 0.5 + 3
  })

  it('reacts to a step change faster than the SMA does', () => {
    // A linear ramp is not a discriminating case — SMA and EMA have the same steady-state
    // lag on one. A step is what separates them.
    const values = [...Array(20).fill(100), ...Array(5).fill(200)]
    expect(latest(emaSeries(values, 10))).toBeGreaterThan(latest(smaSeries(values, 10)))
  })
})

describe('rsiSeries', () => {
  it('reports 100 for a window with no down moves', () => {
    expect(latest(rsiSeries([1, 2, 3, 4, 5, 6], 3))).toBe(100)
  })

  it('reports 0 for a window with no up moves', () => {
    expect(latest(rsiSeries([6, 5, 4, 3, 2, 1], 3))).toBe(0)
  })

  it('sits at 50 when average gains and losses are equal', () => {
    expect(latest(rsiSeries([10, 12, 10, 12, 10, 12], 4))).toBeCloseTo(50)
  })

  it('needs one more bar than the period, for the first change', () => {
    const out = rsiSeries([1, 2, 3], 2)
    expect(out[1]).toBeNull()
    expect(out[2]).not.toBeNull()
  })
})

describe('macdSeries', () => {
  it('keeps macd, signal, and histogram aligned with the input series', () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + i)
    const { macd, signal, histogram } = macdSeries(values)
    expect(macd).toHaveLength(60)
    expect(signal).toHaveLength(60)
    expect(histogram).toHaveLength(60)
    // The signal line warms up strictly after the MACD line it is an EMA of.
    expect(macd.findIndex((v) => v != null)).toBeLessThan(signal.findIndex((v) => v != null))
  })

  it('makes histogram exactly macd minus signal wherever both are defined', () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5)
    const { macd, signal, histogram } = macdSeries(values)
    for (let i = 0; i < values.length; i++) {
      if (signal[i] == null) continue
      expect(histogram[i]).toBeCloseTo(macd[i] - signal[i])
    }
  })

  it('is positive on a steadily rising series and negative on a falling one', () => {
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i)
    const falling = Array.from({ length: 60 }, (_, i) => 160 - i)
    expect(latest(macdSeries(rising).macd)).toBeGreaterThan(0)
    expect(latest(macdSeries(falling).macd)).toBeLessThan(0)
  })

  it('returns all-null series when the slow EMA never warms up', () => {
    const { macd, signal, histogram } = macdSeries([1, 2, 3])
    expect(macd.every((v) => v == null)).toBe(true)
    expect(signal.every((v) => v == null)).toBe(true)
    expect(histogram.every((v) => v == null)).toBe(true)
  })
})

describe('bollingerSeries', () => {
  it('centers the bands on the SMA and spaces them by the window stdev', () => {
    const values = [2, 4, 6, 8, 10]
    const { middle, upper, lower } = bollingerSeries(values, { period: 5, stdDevs: 2 })
    expect(middle[4]).toBeCloseTo(6)
    // Population stdev of 2,4,6,8,10 is sqrt(8) ≈ 2.8284.
    expect(upper[4]).toBeCloseTo(6 + 2 * Math.sqrt(8))
    expect(lower[4]).toBeCloseTo(6 - 2 * Math.sqrt(8))
  })

  it('puts %B at 1 at the upper band and 0 at the lower', () => {
    const values = [2, 4, 6, 8, 10]
    const { upper, lower, percentB } = bollingerSeries(values, { period: 5, stdDevs: 2 })
    expect(percentB[4]).toBeCloseTo((10 - lower[4]) / (upper[4] - lower[4]))
    expect(percentB[4]).toBeGreaterThan(0.5)
  })

  it('leaves %B null on a flat window instead of dividing by a zero-width band', () => {
    const { percentB, upper, lower } = bollingerSeries([5, 5, 5, 5, 5], { period: 5 })
    expect(upper[4]).toBeCloseTo(5)
    expect(lower[4]).toBeCloseTo(5)
    expect(percentB[4]).toBeNull()
  })
})

describe('atrSeries', () => {
  it('averages the trailing true ranges, warming up one bar after the period', () => {
    const bars = [
      { high: 11, low: 9, close: 10 },
      { high: 12, low: 10, close: 11 },
      { high: 13, low: 11, close: 12 },
      { high: 14, low: 12, close: 13 },
    ]
    const out = atrSeries(bars, 2)
    expect(out.slice(0, 2)).toEqual([null, null])
    // Every true range here is 2 (high-low), so the average is 2.
    expect(out[3]).toBeCloseTo(2)
  })

  it('counts a gap through the previous close as part of the range', () => {
    const bars = [
      { high: 11, low: 9, close: 10 },
      { high: 20, low: 19, close: 20 }, // gapped up: true range is 20 - 10, not 20 - 19
    ]
    expect(latest(atrSeries(bars, 1))).toBeCloseTo(10)
  })
})

describe('latest and tail', () => {
  it('latest skips trailing nulls and returns null for an all-null series', () => {
    expect(latest([1, 2, null])).toBe(2)
    expect(latest([null, null])).toBeNull()
  })

  it('tail returns only defined values, at most count of them', () => {
    expect(tail([null, 1, 2, 3, 4], 3)).toEqual([2, 3, 4])
    expect(tail([null, 1], 5)).toEqual([1])
    expect(tail([null, null], 3)).toEqual([])
  })
})
