import { describe, it, expect } from 'vitest'
import { generateSignals, summarizeSignals } from '../src/analytics/signals.js'

/** Bars from a close series, one trading day apart, with OHLC bracketing the close. */
function bars(closes, start = '2024-01-01') {
  const base = new Date(start)
  return closes.map((close, i) => {
    const ts = new Date(base)
    ts.setDate(ts.getDate() + i)
    return {
      symbol: 'TEST',
      ts: ts.toISOString(),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1000,
    }
  })
}

/** A long steadily-rising series — enough bars for every indicator to warm up. */
function risingCloses(n = 260) {
  return Array.from({ length: n }, (_, i) => 100 + i * 0.5)
}

function find(result, indicator) {
  return result.signals.find((s) => s.indicator === indicator)
}

describe('generateSignals', () => {
  it('emits every indicator when the series is long enough', () => {
    const result = generateSignals('test', bars(risingCloses()))
    expect(result.symbol).toBe('TEST')
    expect(result.skipped).toEqual([])
    expect(result.signals.map((s) => s.indicator).sort()).toEqual([
      '50/200 SMA',
      'Bollinger %B',
      'MACD',
      'RSI(14)',
    ])
  })

  it('skips indicators the series is too short for, saying why', () => {
    const result = generateSignals('TEST', bars(risingCloses(40)))
    expect(find(result, 'RSI(14)')).toBeDefined()
    expect(find(result, '50/200 SMA')).toBeUndefined()

    const skipped = result.skipped.find((s) => s.indicator === '50/200 SMA')
    expect(skipped.reason).toBe('needs 200 bars, have 40')
  })

  it('returns no signals and all-skipped for an empty series', () => {
    const result = generateSignals('TEST', [])
    expect(result.signals).toEqual([])
    expect(result.skipped).toHaveLength(4)
    expect(result.barCount).toBe(0)
    expect(result.lastBarTs).toBeNull()
  })

  it('calls a relentlessly rising series overbought and bullish', () => {
    const result = generateSignals('TEST', bars(risingCloses()))
    expect(find(result, 'RSI(14)').signal).toBe('Overbought')
    expect(find(result, 'RSI(14)').direction).toBe('bearish')
    expect(find(result, 'MACD').direction).toBe('bullish')
    expect(find(result, '50/200 SMA').direction).toBe('bullish')
    expect(find(result, '50/200 SMA').value).toBeGreaterThan(1)
  })

  it('calls a relentlessly falling series oversold and bearish', () => {
    const falling = risingCloses().map((_, i, arr) => arr[arr.length - 1 - i])
    const result = generateSignals('TEST', bars(falling))
    expect(find(result, 'RSI(14)').signal).toBe('Oversold')
    expect(find(result, 'RSI(14)').direction).toBe('bullish')
    expect(find(result, 'MACD').direction).toBe('bearish')
    expect(find(result, '50/200 SMA').signal).toBe('Below 200-period')
  })

  it('names the golden cross on the bar the fast average crosses above the slow', () => {
    // Flat for long enough to warm up both averages, then a sustained rally that drags
    // the 50-period average up through the 200-period one.
    const closes = [...Array(200).fill(100), ...Array(60).fill(0).map((_, i) => 100 + i * 2)]
    const series = bars(closes)

    // Walk forward until the crossover bar, then assert it is labelled there.
    let crossIndex = -1
    for (let i = 200; i < series.length; i++) {
      const signal = find(generateSignals('TEST', series.slice(0, i + 1)), '50/200 SMA')
      if (signal?.signal === 'Golden cross') {
        crossIndex = i
        break
      }
    }
    expect(crossIndex).toBeGreaterThan(-1)

    // It is a crossover, not a state: the bar after it reports the standing regime.
    const after = find(generateSignals('TEST', series.slice(0, crossIndex + 2)), '50/200 SMA')
    expect(after.signal).toBe('Above 200-period')
  })

  it('flags %B against the upper band on a breakout and the lower band on a breakdown', () => {
    const up = generateSignals('TEST', bars([...Array(25).fill(100), 130]))
    expect(find(up, 'Bollinger %B').signal).toBe('Near upper band')

    const down = generateSignals('TEST', bars([...Array(25).fill(100), 70]))
    expect(find(down, 'Bollinger %B').signal).toBe('Near lower band')
  })

  it('leaves Bollinger direction neutral — band position is not a directional call', () => {
    const result = generateSignals('TEST', bars([...Array(25).fill(100), 130]))
    expect(find(result, 'Bollinger %B').direction).toBe('neutral')
  })

  it('keeps strength inside 0-100 and trends no longer than requested', () => {
    const result = generateSignals('TEST', bars(risingCloses()), { trendLength: 5 })
    for (const signal of result.signals) {
      expect(signal.strength).toBeGreaterThanOrEqual(0)
      expect(signal.strength).toBeLessThanOrEqual(100)
      expect(signal.trend.length).toBeLessThanOrEqual(5)
      expect(signal.trend.every((v) => v != null)).toBe(true)
    }
  })

  it('normalizes MACD strength against the symbol, not an absolute scale', () => {
    // The same shape at two price levels should read as comparably extended, even though
    // the raw histogram values differ by an order of magnitude.
    const shape = risingCloses()
    const cheap = find(generateSignals('A', bars(shape)), 'MACD')
    const pricey = find(generateSignals('B', bars(shape.map((c) => c * 10))), 'MACD')

    expect(pricey.value).toBeGreaterThan(cheap.value * 5)
    expect(pricey.strength).toBeCloseTo(cheap.strength, 6)
  })

  it('is deterministic — the same bars give the same signals', () => {
    const series = bars(risingCloses())
    expect(generateSignals('TEST', series)).toEqual(generateSignals('TEST', series))
  })
})

describe('summarizeSignals', () => {
  it('counts direction across symbols and averages strength', () => {
    const summary = summarizeSignals([
      { signals: [{ direction: 'bullish', strength: 80 }, { direction: 'neutral', strength: 20 }] },
      { signals: [{ direction: 'bearish', strength: 50 }] },
    ])
    expect(summary).toMatchObject({
      symbolCount: 2,
      signalCount: 3,
      bullish: 1,
      bearish: 1,
      neutral: 1,
    })
    expect(summary.avgStrength).toBeCloseTo(50)
  })

  it('reports zero strength rather than NaN when nothing was generated', () => {
    expect(summarizeSignals([]).avgStrength).toBe(0)
    expect(summarizeSignals([{ signals: [] }]).avgStrength).toBe(0)
  })
})
