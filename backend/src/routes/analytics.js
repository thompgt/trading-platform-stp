import { Router } from 'express'
import { loadBars, listCachedSymbols } from '../data/marketData.js'
import { generateSignals, summarizeSignals } from '../analytics/signals.js'
import {
  smaSeries,
  emaSeries,
  rsiSeries,
  macdSeries,
  bollingerSeries,
  atrSeries,
} from '../analytics/indicators.js'
import { analyticsSignalsTotal } from '../metrics/registry.js'

/** Cap on how many cached symbols are scanned when the caller doesn't name any. */
const DEFAULT_SYMBOL_LIMIT = 8

function parseSymbols(param) {
  if (!param) return null
  const symbols = String(param)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  return symbols.length > 0 ? symbols : null
}

export function analyticsRouter(db) {
  const router = Router()

  /**
   * Current signals across symbols. Without `?symbols=`, scans what's already cached —
   * the page is then useful immediately after any market data has been fetched, with no
   * separate configuration step.
   */
  router.get('/signals', async (req, res, next) => {
    try {
      let symbols = parseSymbols(req.query.symbols)
      if (!symbols) {
        const cached = await listCachedSymbols(db)
        symbols = cached.slice(0, DEFAULT_SYMBOL_LIMIT).map((s) => s.symbol)
      }

      const trendLength = Number(req.query.trendLength) || 12
      const results = []
      for (const symbol of symbols) {
        const bars = await loadBars(db, symbol)
        results.push(generateSignals(symbol, bars, { trendLength }))
      }

      for (const signal of results.flatMap((r) => r.signals)) {
        analyticsSignalsTotal.inc({ indicator: signal.indicator, direction: signal.direction })
      }

      res.json({
        symbols,
        results,
        signals: results.flatMap((r) => r.signals),
        skipped: results.flatMap((r) => r.skipped),
        summary: summarizeSignals(results),
      })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Full indicator series for one symbol, aligned to its bars — the raw library output,
   * for charting or for checking what a signal was derived from.
   */
  router.get('/indicators/:symbol', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase()
      const bars = await loadBars(db, symbol, { start: req.query.start, end: req.query.end })
      const closes = bars.map((b) => b.close)
      const { macd, signal, histogram } = macdSeries(closes)
      const { middle, upper, lower, percentB } = bollingerSeries(closes)

      res.json({
        symbol,
        ts: bars.map((b) => b.ts),
        close: closes,
        indicators: {
          sma20: smaSeries(closes, 20),
          sma50: smaSeries(closes, 50),
          sma200: smaSeries(closes, 200),
          ema12: emaSeries(closes, 12),
          ema26: emaSeries(closes, 26),
          rsi14: rsiSeries(closes, 14),
          macd,
          macdSignal: signal,
          macdHistogram: histogram,
          bollingerMiddle: middle,
          bollingerUpper: upper,
          bollingerLower: lower,
          percentB,
          atr14: atrSeries(bars, 14),
        },
      })
    } catch (err) {
      next(err)
    }
  })

  return router
}
