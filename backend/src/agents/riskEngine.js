/**
 * Market & Pre-Trade Risk Agent — deterministic, rules-based (workplan.md §2/§5: risk
 * agents are "Rules (hard gate)" / "Quant" in nature, never gen-AI). Evaluates a paper
 * trading session's live state (position, cash, equity history) against configurable
 * limits and returns structured alerts. No LLM involved — risk gates must be explainable
 * and reproducible, not generated.
 */

export const DEFAULT_LIMITS = {
  concentrationWarn: 0.4, // position notional / equity
  concentrationHigh: 0.7,
  drawdownWarn: 0.05, // (peak - current) / peak
  drawdownHigh: 0.15,
  dailyVolWarn: 0.02, // stdev of daily returns
  dailyVolHigh: 0.04,
}

function stdev(values) {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function dailyReturns(equityCurve) {
  const returns = []
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity
    if (prev > 0) returns.push((equityCurve[i].equity - prev) / prev)
  }
  return returns
}

/**
 * Evaluate risk for a single symbol's live simulation state. Returns alerts sorted
 * most-severe first (empty array if within all limits).
 */
export function evaluateRisk(
  { symbol, cash, position, currentPrice, startingCash, equityCurve = [] },
  limits = DEFAULT_LIMITS,
) {
  const alerts = []
  const now = new Date().toISOString().slice(11, 19)
  const equity = cash + position * (currentPrice ?? 0)

  if (equity > 0 && position > 0 && currentPrice != null) {
    const notional = position * currentPrice
    const concentration = notional / equity
    if (concentration >= limits.concentrationHigh) {
      alerts.push({
        id: `RSK-CONC-${symbol}`,
        severity: 'high',
        agent: 'Pre-Trade Risk',
        message: `${symbol} position is ${(concentration * 100).toFixed(0)}% of equity — exceeds concentration limit (${(limits.concentrationHigh * 100).toFixed(0)}%)`,
        time: now,
      })
    } else if (concentration >= limits.concentrationWarn) {
      alerts.push({
        id: `RSK-CONC-${symbol}`,
        severity: 'medium',
        agent: 'Pre-Trade Risk',
        message: `${symbol} position is ${(concentration * 100).toFixed(0)}% of equity — approaching concentration limit (${(limits.concentrationHigh * 100).toFixed(0)}%)`,
        time: now,
      })
    }
  }

  if (equityCurve.length > 1) {
    let peak = equityCurve[0].equity
    let maxDrawdown = 0
    for (const point of equityCurve) {
      peak = Math.max(peak, point.equity)
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak)
    }
    if (maxDrawdown >= limits.drawdownHigh) {
      alerts.push({
        id: `RSK-DD-${symbol}`,
        severity: 'high',
        agent: 'Market Risk',
        message: `${symbol} strategy drawdown reached ${(maxDrawdown * 100).toFixed(1)}% from peak equity — exceeds limit (${(limits.drawdownHigh * 100).toFixed(0)}%)`,
        time: now,
      })
    } else if (maxDrawdown >= limits.drawdownWarn) {
      alerts.push({
        id: `RSK-DD-${symbol}`,
        severity: 'medium',
        agent: 'Market Risk',
        message: `${symbol} strategy drawdown reached ${(maxDrawdown * 100).toFixed(1)}% from peak equity`,
        time: now,
      })
    }

    const vol = stdev(dailyReturns(equityCurve))
    if (vol >= limits.dailyVolHigh) {
      alerts.push({
        id: `RSK-VOL-${symbol}`,
        severity: 'high',
        agent: 'Market Risk',
        message: `${symbol} equity curve daily volatility is ${(vol * 100).toFixed(2)}% — exceeds VaR proxy limit (${(limits.dailyVolHigh * 100).toFixed(1)}%)`,
        time: now,
      })
    } else if (vol >= limits.dailyVolWarn) {
      alerts.push({
        id: `RSK-VOL-${symbol}`,
        severity: 'low',
        agent: 'Market Risk',
        message: `${symbol} equity curve daily volatility is ${(vol * 100).toFixed(2)}%, within tolerance but elevated`,
        time: now,
      })
    }
  }

  const severityOrder = { high: 0, medium: 1, low: 2 }
  return alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
}
