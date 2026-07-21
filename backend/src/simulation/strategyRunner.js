/**
 * Deterministic execution of a *structured* strategy definition against a bar series.
 *
 * Strategies are parameters (indicator + thresholds), never LLM-generated code — the
 * Groq strategy agent proposes values for one of these shapes, they're validated, and
 * only then run here. This keeps "gen-AI proposes, code executes" (workplan.md §5/§7):
 * nothing the model outputs is ever eval()'d.
 */

function sma(values, period, index) {
  if (index + 1 < period) return null
  let sum = 0
  for (let i = index - period + 1; i <= index; i++) sum += values[i]
  return sum / period
}

export const STRATEGY_KINDS = ['sma_crossover', 'rsi_threshold']

export function runStrategy(strategy, bars, { startingCash = 100000 } = {}) {
  if (!STRATEGY_KINDS.includes(strategy.kind)) {
    throw new Error(`Unknown strategy kind: ${strategy.kind}`)
  }
  if (bars.length === 0) {
    return { trades: [], equityCurve: [], finalCash: startingCash, finalPosition: 0 }
  }

  const closes = bars.map((b) => b.close)
  let cash = startingCash
  let position = 0
  const trades = []
  const equityCurve = []

  for (let i = 0; i < bars.length; i++) {
    const signal = strategy.kind === 'sma_crossover' ? smaCrossoverSignal(strategy, closes, i) : rsiThresholdSignal(strategy, closes, i)

    if (signal === 'BUY' && position === 0 && cash > 0) {
      const qty = Math.floor(cash / bars[i].close)
      if (qty > 0) {
        position = qty
        cash -= qty * bars[i].close
        trades.push({ ts: bars[i].ts, side: 'BUY', qty, price: bars[i].close })
      }
    } else if (signal === 'SELL' && position > 0) {
      cash += position * bars[i].close
      trades.push({ ts: bars[i].ts, side: 'SELL', qty: position, price: bars[i].close })
      position = 0
    }

    const equity = cash + position * bars[i].close
    equityCurve.push({ ts: bars[i].ts, equity })
  }

  return { trades, equityCurve, finalCash: cash, finalPosition: position }
}

function smaCrossoverSignal(strategy, closes, i) {
  const { fastPeriod, slowPeriod } = strategy.params
  const fastPrev = sma(closes, fastPeriod, i - 1)
  const slowPrev = sma(closes, slowPeriod, i - 1)
  const fastNow = sma(closes, fastPeriod, i)
  const slowNow = sma(closes, slowPeriod, i)
  if (fastPrev == null || slowPrev == null || fastNow == null || slowNow == null) return null

  if (fastPrev <= slowPrev && fastNow > slowNow) return 'BUY'
  if (fastPrev >= slowPrev && fastNow < slowNow) return 'SELL'
  return null
}

function rsi(closes, period, index) {
  if (index + 1 < period + 1) return null
  let gains = 0
  let losses = 0
  for (let i = index - period + 1; i <= index; i++) {
    const change = closes[i] - closes[i - 1]
    if (change >= 0) gains += change
    else losses -= change
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function rsiThresholdSignal(strategy, closes, i) {
  const { period, oversold, overbought } = strategy.params
  const value = rsi(closes, period, i)
  if (value == null) return null
  if (value <= oversold) return 'BUY'
  if (value >= overbought) return 'SELL'
  return null
}
