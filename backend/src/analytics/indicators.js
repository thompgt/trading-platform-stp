/**
 * Deterministic technical-indicator library (workplan.md §6).
 *
 * Every function takes a full series and returns a full-length series, using `null` for
 * bars inside the indicator's warm-up window rather than silently shortening the array.
 * Keeping input and output aligned by index is what lets callers zip an indicator back
 * onto the bars it came from without off-by-one bookkeeping at each call site.
 *
 * These are the same primitives the strategy runner executes and the signal generator
 * reads, so a signal shown on the Technical Analytics page and a backtest decision are
 * computed by identical code — not two implementations that agree by luck.
 */

/** Simple moving average. */
export function smaSeries(values, period) {
  const out = new Array(values.length).fill(null)
  if (!(period >= 1) || values.length < period) return out

  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values — the
 * conventional seed, and the one that makes the series independent of how much history
 * happens to be loaded before the window.
 */
export function emaSeries(values, period) {
  const out = new Array(values.length).fill(null)
  if (!(period >= 1) || values.length < period) return out

  const multiplier = 2 / (period + 1)
  let sum = 0
  for (let i = 0; i < period; i++) sum += values[i]
  let ema = sum / period
  out[period - 1] = ema

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema
    out[i] = ema
  }
  return out
}

/**
 * Relative Strength Index using simple (not Wilder-smoothed) average gain/loss over the
 * trailing `period` changes. The simple form is used consistently across the platform so
 * the strategy runner's RSI entries and the RSI shown on the analytics page are the same
 * number; switching to Wilder later would need to change both together.
 *
 * A window with no down moves has no defined RS, and is reported as 100 by convention.
 */
export function rsiSeries(values, period) {
  const out = new Array(values.length).fill(null)
  if (!(period >= 1) || values.length < period + 1) return out

  for (let i = period; i < values.length; i++) {
    let gains = 0
    let losses = 0
    for (let j = i - period + 1; j <= i; j++) {
      const change = values[j] - values[j - 1]
      if (change >= 0) gains += change
      else losses -= change
    }
    const avgGain = gains / period
    const avgLoss = losses / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

/**
 * MACD: the fast/slow EMA spread, its signal-line EMA, and the histogram between them.
 *
 * The signal line is an EMA *of the MACD line*, which only exists after the slow EMA has
 * warmed up — so it is computed over the defined portion and mapped back to the original
 * indices, keeping all three series aligned with `values`.
 */
export function macdSeries(values, { fastPeriod = 12, slowPeriod = 26, signalPeriod = 9 } = {}) {
  const empty = () => new Array(values.length).fill(null)
  const fast = emaSeries(values, fastPeriod)
  const slow = emaSeries(values, slowPeriod)

  const macd = empty()
  for (let i = 0; i < values.length; i++) {
    if (fast[i] != null && slow[i] != null) macd[i] = fast[i] - slow[i]
  }

  const firstDefined = macd.findIndex((v) => v != null)
  const signal = empty()
  const histogram = empty()
  if (firstDefined === -1) return { macd, signal, histogram }

  const signalOfDefined = emaSeries(macd.slice(firstDefined), signalPeriod)
  for (let i = 0; i < signalOfDefined.length; i++) {
    if (signalOfDefined[i] == null) continue
    const index = firstDefined + i
    signal[index] = signalOfDefined[i]
    histogram[index] = macd[index] - signalOfDefined[i]
  }
  return { macd, signal, histogram }
}

/** Population standard deviation of the `period` values ending at `end` (inclusive). */
function windowStdev(values, period, end) {
  let sum = 0
  for (let i = end - period + 1; i <= end; i++) sum += values[i]
  const mean = sum / period
  let variance = 0
  for (let i = end - period + 1; i <= end; i++) variance += (values[i] - mean) ** 2
  // Population, not sample: Bollinger bands are conventionally defined over the window
  // treated as the whole population, and the sample form would widen every band slightly.
  return Math.sqrt(variance / period)
}

/**
 * Bollinger bands and %B — where price sits within the band, 0 at the lower band and 1 at
 * the upper. A window with zero variance has no width, so %B is left null there rather
 * than dividing by zero and reporting a confident-looking Infinity.
 */
export function bollingerSeries(values, { period = 20, stdDevs = 2 } = {}) {
  const middle = smaSeries(values, period)
  const upper = new Array(values.length).fill(null)
  const lower = new Array(values.length).fill(null)
  const percentB = new Array(values.length).fill(null)

  for (let i = 0; i < values.length; i++) {
    if (middle[i] == null) continue
    const sd = windowStdev(values, period, i)
    upper[i] = middle[i] + stdDevs * sd
    lower[i] = middle[i] - stdDevs * sd
    const width = upper[i] - lower[i]
    if (width > 0) percentB[i] = (values[i] - lower[i]) / width
  }
  return { middle, upper, lower, percentB }
}

/**
 * Average True Range over OHLC bars, as a simple mean of the trailing true ranges. The
 * first bar has no previous close, so true range starts at index 1 and ATR warms up one
 * bar later than a close-only indicator of the same period.
 */
export function atrSeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null)
  if (!(period >= 1) || bars.length < period + 1) return out

  const trueRanges = new Array(bars.length).fill(null)
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close
    trueRanges[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    )
  }

  for (let i = period; i < bars.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += trueRanges[j]
    out[i] = sum / period
  }
  return out
}

/** Last non-null value of a series, or null if it never warmed up. */
export function latest(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i]
  }
  return null
}

/**
 * The trailing `count` defined values of a series, for sparkline rendering. Returns fewer
 * than `count` when the series is short, and an empty array when it never warmed up —
 * callers render an empty sparkline rather than padding with invented values.
 */
export function tail(series, count) {
  const defined = series.filter((v) => v != null)
  return defined.slice(Math.max(0, defined.length - count))
}
