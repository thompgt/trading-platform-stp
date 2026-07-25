/**
 * Deterministic trading-performance analytics over a replayed session.
 *
 * Everything here is computed from the equity curve and the trade tape the simulation
 * engine already produces — no LLM, no sampling, no hidden state. The same inputs always
 * give the same numbers, which is what makes these safe to show next to risk output
 * (workplan.md §5: quant/rules surfaces must be reproducible and explainable).
 */

const TRADING_PERIODS_PER_YEAR = 252
const TRADING_DAY_MS = 6.5 * 60 * 60 * 1000 // a 6.5-hour US cash session

/**
 * How many bars of this size fit in a trading year, inferred from the median gap between
 * bars. Annualizing intraday returns with the daily 252 would overstate Sharpe by an order
 * of magnitude, so the scaling has to follow the data rather than a fixed assumption.
 * Falls back to daily when there isn't enough of a series to measure.
 */
export function inferPeriodsPerYear(bars) {
  if (!Array.isArray(bars) || bars.length < 3) return TRADING_PERIODS_PER_YEAR

  const gaps = []
  for (let i = 1; i < bars.length; i++) {
    const gap = new Date(bars[i].ts).getTime() - new Date(bars[i - 1].ts).getTime()
    if (gap > 0) gaps.push(gap)
  }
  if (gaps.length === 0) return TRADING_PERIODS_PER_YEAR

  // Median, not mean: overnight and weekend gaps in an intraday series are large outliers
  // that would otherwise drag the estimate toward "daily".
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]

  // A series with *no* dominant bar size — e.g. daily and 5-minute bars for the same
  // symbol replayed together — has no meaningful annualization factor, and trusting the
  // median would scale it as though every bar were 5 minutes, inflating Sharpe roughly
  // 9x. Fall back to daily when fewer than half the gaps sit near the median.
  const nearMedian = gaps.filter((g) => g >= median * 0.5 && g <= median * 2).length
  if (nearMedian / gaps.length < 0.5) return TRADING_PERIODS_PER_YEAR

  if (median >= 20 * 60 * 60 * 1000) {
    // Daily or coarser — scale down from 252 for weekly/monthly series.
    return Math.max(1, Math.round(TRADING_PERIODS_PER_YEAR / (median / (24 * 60 * 60 * 1000))))
  }
  return Math.round(TRADING_PERIODS_PER_YEAR * (TRADING_DAY_MS / median))
}

function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function stdev(values) {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/** Period-over-period returns of the equity curve, skipping any non-positive equity. */
function periodReturns(equityCurve) {
  const returns = []
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity
    if (prev > 0) returns.push((equityCurve[i].equity - prev) / prev)
  }
  return returns
}

/**
 * Pair each BUY with the SELL that closes it. The strategy runner is long-flat only, so
 * trades alternate — but pairing defensively means a malformed tape degrades to "fewer
 * round trips" rather than throwing.
 */
export function roundTrips(trades) {
  const closed = []
  let open = null
  for (const trade of trades) {
    if (trade.side === 'BUY') {
      if (!open) open = trade
    } else if (trade.side === 'SELL' && open) {
      const qty = Math.min(open.qty, trade.qty)
      closed.push({
        entryTs: open.ts,
        exitTs: trade.ts,
        qty,
        entryPrice: open.price,
        exitPrice: trade.price,
        pnl: (trade.price - open.price) * qty,
        returnPct: open.price > 0 ? ((trade.price - open.price) / open.price) * 100 : 0,
      })
      open = null
    }
  }
  return closed
}

/**
 * Fraction of the replayed window spent holding a position, from the trade tape.
 * A still-open position counts as held through the end of the curve.
 */
function timeInMarket(equityCurve, trades) {
  if (equityCurve.length === 0) return 0
  const times = equityCurve.map((p) => new Date(p.ts).getTime())
  let held = 0
  let entry = null
  for (const trade of trades) {
    const t = new Date(trade.ts).getTime()
    if (trade.side === 'BUY' && entry === null) entry = t
    else if (trade.side === 'SELL' && entry !== null) {
      held += times.filter((x) => x >= entry && x <= t).length
      entry = null
    }
  }
  if (entry !== null) held += times.filter((x) => x >= entry).length
  return held / times.length
}

/**
 * Full performance summary for a session.
 *
 * `periodsPerYear` scales the annualized figures (Sharpe, Sortino, volatility) to the bar
 * size being replayed — 252 for daily bars, far higher for intraday. Callers that replay
 * 5-minute bars should pass the matching value rather than letting daily be assumed.
 */
export function computePerformance({
  equityCurve = [],
  trades = [],
  startingCash = 100000,
  periodsPerYear = TRADING_PERIODS_PER_YEAR,
} = {}) {
  const startEquity = equityCurve.length > 0 ? equityCurve[0].equity : startingCash
  const baseline = startingCash > 0 ? startingCash : startEquity

  // Cumulative P&L and the underwater (drawdown) series, in one pass over the curve.
  const pnlCurve = []
  const drawdownCurve = []
  let peak = equityCurve.length > 0 ? equityCurve[0].equity : baseline
  let maxDrawdownPct = 0
  let maxDrawdownValue = 0

  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity)
    const ddValue = peak - point.equity
    const ddPct = peak > 0 ? (ddValue / peak) * 100 : 0
    maxDrawdownPct = Math.max(maxDrawdownPct, ddPct)
    maxDrawdownValue = Math.max(maxDrawdownValue, ddValue)
    pnlCurve.push({ ts: point.ts, pnl: point.equity - baseline, equity: point.equity })
    // Negative so the chart reads as an underwater plot hanging below zero.
    // Guarded against -0, which would otherwise show up at every new high.
    drawdownCurve.push({ ts: point.ts, drawdown: ddPct === 0 ? 0 : -ddPct })
  }

  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : baseline
  const totalPnl = finalEquity - baseline
  const totalReturnPct = baseline > 0 ? (totalPnl / baseline) * 100 : 0
  const currentDrawdownPct = peak > 0 ? ((peak - finalEquity) / peak) * 100 : 0

  const returns = periodReturns(equityCurve)
  const avgReturn = mean(returns)
  const volatility = stdev(returns)
  const downside = stdev(returns.filter((r) => r < 0))
  const annualFactor = Math.sqrt(periodsPerYear)

  // Risk-free rate is taken as zero — this is a paper-trading sandbox, not a
  // benchmark-relative performance claim.
  const sharpe = volatility > 0 ? (avgReturn / volatility) * annualFactor : 0
  const sortino = downside > 0 ? (avgReturn / downside) * annualFactor : 0

  const closed = roundTrips(trades)
  const wins = closed.filter((t) => t.pnl > 0)
  const losses = closed.filter((t) => t.pnl < 0)
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0))

  return {
    startingCash: baseline,
    finalEquity,
    totalPnl,
    totalReturnPct,
    maxDrawdownPct,
    maxDrawdownValue,
    currentDrawdownPct,
    volatilityPct: volatility * annualFactor * 100,
    sharpe,
    sortino,
    tradeCount: trades.length,
    roundTripCount: closed.length,
    winCount: wins.length,
    lossCount: losses.length,
    // Undefined rather than a misleading 0% when nothing has closed yet.
    winRatePct: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    // A run with no losses has an undefined (not infinite) profit factor.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    grossProfit,
    grossLoss,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
    bestTradePct: closed.length > 0 ? Math.max(...closed.map((t) => t.returnPct)) : null,
    worstTradePct: closed.length > 0 ? Math.min(...closed.map((t) => t.returnPct)) : null,
    bestPeriodPct: returns.length > 0 ? Math.max(...returns) * 100 : null,
    worstPeriodPct: returns.length > 0 ? Math.min(...returns) * 100 : null,
    exposurePct: timeInMarket(equityCurve, trades) * 100,
    barsElapsed: equityCurve.length,
    pnlCurve,
    drawdownCurve,
    closedTrades: closed,
  }
}
