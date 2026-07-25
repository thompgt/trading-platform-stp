/**
 * Technical Analytics Agent — deterministic signal generation (workplan.md §2, §6).
 *
 * Reads the indicator library over a symbol's stored bars and emits a row per indicator:
 * the current reading, a plain-language signal label, a bullish/bearish/neutral direction,
 * a 0-100 strength, and a short trailing series for the sparkline.
 *
 * This is a *rules* agent, not a gen-AI one — no model is consulted and nothing here is
 * ever drafted. The same bars always produce the same signals, which is what lets these
 * sit next to risk output and be relied on.
 *
 * An indicator whose warm-up window the series can't cover is reported in `skipped` with
 * the reason, rather than emitted against a shorter period that would quietly answer a
 * different question than the label claims.
 */
import {
  smaSeries,
  rsiSeries,
  macdSeries,
  bollingerSeries,
  latest,
  tail,
} from './indicators.js'

const RSI_PERIOD = 14
const RSI_OVERBOUGHT = 70
const RSI_OVERSOLD = 30
const SMA_FAST = 50
const SMA_SLOW = 200
const BOLLINGER_PERIOD = 20
const BAND_EDGE = 0.9 // %B at or beyond this (or its mirror) counts as riding a band
const MACD_SLOW = 26
const MACD_SIGNAL = 9

/** Clamp to the 0-100 range the strength meter renders. */
function pct(value) {
  return Math.max(0, Math.min(100, value))
}

/**
 * How far a reading sits from its neutral center, as a percentage of the span at which it
 * counts as fully extended. Indicators have different units and ranges, so each passes its
 * own center/span and the meter compares like with like.
 */
function extremity(value, center, span) {
  if (!(span > 0)) return 0
  return pct((Math.abs(value - center) / span) * 100)
}

/** The last two defined values of a series, for detecting a crossover on the latest bar. */
function lastTwo(series) {
  const defined = series.filter((v) => v != null)
  return defined.length < 2 ? null : [defined[defined.length - 2], defined[defined.length - 1]]
}

function rsiSignal(symbol, closes, trendLength) {
  const series = rsiSeries(closes, RSI_PERIOD)
  const value = latest(series)
  if (value == null) return null

  let signal = 'Neutral'
  let direction = 'neutral'
  if (value >= RSI_OVERBOUGHT) {
    signal = 'Overbought'
    direction = 'bearish'
  } else if (value <= RSI_OVERSOLD) {
    signal = 'Oversold'
    direction = 'bullish'
  }

  return {
    symbol,
    indicator: `RSI(${RSI_PERIOD})`,
    value,
    signal,
    direction,
    strength: extremity(value, 50, 50),
    trend: tail(series, trendLength),
    detail: `${value.toFixed(1)} against ${RSI_OVERSOLD}/${RSI_OVERBOUGHT} bands`,
  }
}

function macdSignal(symbol, closes, trendLength) {
  const { macd, histogram } = macdSeries(closes)
  const value = latest(macd)
  const hist = latest(histogram)
  if (value == null) return null

  // Two different readings, deliberately not conflated. The MACD line's position against
  // the zero line is the *trend*; the histogram flipping sign is the signal-line
  // *crossover*. A steady uptrend decays the histogram toward zero while the trend is
  // still plainly up, so taking direction from the histogram would call it bearish.
  const pair = lastTwo(histogram)
  const crossed = pair != null && Math.sign(pair[0]) !== Math.sign(pair[1]) && pair[0] !== 0
  const bullish = value > 0

  let signal
  if (crossed) signal = hist > 0 ? 'Bullish crossover' : 'Bearish crossover'
  else signal = bullish ? 'Above zero line' : 'Below zero line'

  // MACD is unbounded and scales with the price of the instrument, so a fixed span would
  // read as "maximum" on one symbol and "flat" on another. Normalize against the widest
  // swing in the visible window instead, which makes the meter comparable across symbols.
  const recent = tail(macd, trendLength)
  const widest = Math.max(...recent.map(Math.abs), 0)

  return {
    symbol,
    indicator: 'MACD',
    value,
    signal,
    direction: bullish ? 'bullish' : 'bearish',
    strength: extremity(value, 0, widest),
    trend: recent,
    detail: `Line ${value >= 0 ? '+' : ''}${value.toFixed(3)}, histogram ${hist >= 0 ? '+' : ''}${(hist ?? 0).toFixed(3)}`,
  }
}

function smaCrossSignal(symbol, closes, trendLength) {
  const fast = smaSeries(closes, SMA_FAST)
  const slow = smaSeries(closes, SMA_SLOW)
  const ratio = closes.map((_, i) => (fast[i] != null && slow[i] > 0 ? fast[i] / slow[i] : null))

  const value = latest(ratio)
  if (value == null) return null

  const pair = lastTwo(ratio)
  const crossedUp = pair != null && pair[0] <= 1 && pair[1] > 1
  const crossedDown = pair != null && pair[0] >= 1 && pair[1] < 1
  const bullish = value > 1

  let signal
  if (crossedUp) signal = 'Golden cross'
  else if (crossedDown) signal = 'Death cross'
  else signal = bullish ? `Above ${SMA_SLOW}-period` : `Below ${SMA_SLOW}-period`

  return {
    symbol,
    indicator: `${SMA_FAST}/${SMA_SLOW} SMA`,
    value,
    signal,
    direction: bullish ? 'bullish' : 'bearish',
    // A 20% spread between the two averages is treated as fully extended.
    strength: extremity(value, 1, 0.2),
    trend: tail(ratio, trendLength),
    detail: `Fast/slow ratio ${value.toFixed(3)}`,
  }
}

function bollingerSignal(symbol, closes, trendLength) {
  const { percentB } = bollingerSeries(closes, { period: BOLLINGER_PERIOD })
  const value = latest(percentB)
  if (value == null) return null

  let signal = 'Mid band'
  if (value >= BAND_EDGE) signal = 'Near upper band'
  else if (value <= 1 - BAND_EDGE) signal = 'Near lower band'

  return {
    symbol,
    indicator: 'Bollinger %B',
    value,
    // Riding a band is a statement about volatility and position in the range, not a
    // directional call — reading it as either continuation or reversal is a strategy
    // choice this agent deliberately doesn't make on the trader's behalf.
    direction: 'neutral',
    signal,
    strength: extremity(value, 0.5, 0.5),
    trend: tail(percentB, trendLength),
    detail: `%B ${value.toFixed(2)} of the ${BOLLINGER_PERIOD}-period band`,
  }
}

/** Minimum bars each indicator needs before it can be reported honestly. */
const REQUIREMENTS = [
  { indicator: `RSI(${RSI_PERIOD})`, bars: RSI_PERIOD + 1, build: rsiSignal },
  { indicator: 'MACD', bars: MACD_SLOW + MACD_SIGNAL, build: macdSignal },
  { indicator: `${SMA_FAST}/${SMA_SLOW} SMA`, bars: SMA_SLOW, build: smaCrossSignal },
  { indicator: 'Bollinger %B', bars: BOLLINGER_PERIOD, build: bollingerSignal },
]

/**
 * Signals for one symbol's bar series.
 *
 * Returns the emitted signals plus a `skipped` list naming each indicator the series was
 * too short for — an empty table and a table that's short because you loaded three weeks
 * of data are different situations, and the UI should be able to say which it is.
 */
export function generateSignals(symbol, bars, { trendLength = 12 } = {}) {
  const upper = (symbol ?? '').toUpperCase()
  const series = Array.isArray(bars) ? bars : []
  const closes = series.map((b) => b.close).filter((c) => typeof c === 'number' && isFinite(c))

  const signals = []
  const skipped = []

  for (const { indicator, bars: needed, build } of REQUIREMENTS) {
    if (closes.length < needed) {
      skipped.push({
        symbol: upper,
        indicator,
        reason: `needs ${needed} bars, have ${closes.length}`,
      })
      continue
    }
    const signal = build(upper, closes, trendLength)
    if (signal) signals.push(signal)
    else skipped.push({ symbol: upper, indicator, reason: 'indicator did not warm up' })
  }

  return {
    symbol: upper,
    barCount: closes.length,
    lastBarTs: series.length > 0 ? series[series.length - 1].ts : null,
    signals,
    skipped,
  }
}

/** Roll a set of per-symbol results into the headline counts the page's stat tiles show. */
export function summarizeSignals(results) {
  const signals = results.flatMap((r) => r.signals)
  const bullish = signals.filter((s) => s.direction === 'bullish').length
  const bearish = signals.filter((s) => s.direction === 'bearish').length
  const avgStrength =
    signals.length > 0 ? signals.reduce((sum, s) => sum + s.strength, 0) / signals.length : 0

  return {
    symbolCount: results.length,
    signalCount: signals.length,
    bullish,
    bearish,
    neutral: signals.length - bullish - bearish,
    avgStrength,
  }
}
