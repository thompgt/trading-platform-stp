import { Router } from 'express'
import { loadBars, listCachedSymbols, latestBarStamp } from '../data/marketData.js'
import { ExpiringStore } from '../lib/expiringStore.js'
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

/**
 * How many bars back the signal generator looks. 500 comfortably covers the longest warm-up
 * in the library (the 200-period SMA) plus the trend window on top, and it is a fixed cost
 * per symbol instead of "however much history happens to be cached" — which, unbounded and
 * multiplied by eight symbols, is what made this the most expensive endpoint in the app.
 */
const DEFAULT_LOOKBACK = 500
const MAX_LOOKBACK = 5000

/**
 * Signals memoized per (symbol, latest bar, trend length).
 *
 * The computation is a pure function of exactly those things, and the page polls, so without
 * this every poll recomputed every indicator for every symbol from scratch. New bars only
 * ever arrive at the end, so the latest timestamp and the bar count together are a sound
 * cache key: any ingest — append or an INSERT OR REPLACE backfill — changes one of them.
 */
const signalCache = new ExpiringStore({ ttlMs: 5 * 60 * 1000, maxEntries: 200 })

/** Test-only: drop memoized signals so a case cannot serve another's result. */
export function _resetSignalCacheForTesting() {
  signalCache.clear()
}

function boundedLookback(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOOKBACK
  return Math.min(Math.trunc(n), MAX_LOOKBACK)
}

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
      const lookback = boundedLookback(req.query.lookback)

      const results = []
      for (const symbol of symbols) {
        const stamp = await latestBarStamp(db, symbol)
        const cacheKey = stamp
          ? `${symbol}|${stamp.latest}|${stamp.barCount}|${lookback}|${trendLength}`
          : null

        const cached = cacheKey ? signalCache.get(cacheKey) : undefined
        if (cached) {
          results.push(cached)
          continue
        }

        const bars = await loadBars(db, symbol, { limit: lookback })
        const result = generateSignals(symbol, bars, { trendLength })
        if (cacheKey) signalCache.set(cacheKey, result)
        results.push(result)
      }

      for (const signal of results.flatMap((r) => r.signals)) {
        analyticsSignalsTotal.inc({ indicator: signal.indicator, direction: signal.direction })
      }

      res.json({
        symbols,
        lookback,
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
