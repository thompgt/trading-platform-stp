import { Router } from 'express'
import { fetchBars, storeBars, loadBars, listCachedSymbols } from '../data/marketData.js'
import { barsIngestedTotal, marketDataFetchDuration } from '../metrics/registry.js'

export function dataRouter(db) {
  const router = Router()

  router.get('/symbols', async (req, res) => {
    try {
      const symbols = await listCachedSymbols(db)
      res.json({ symbols })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/fetch', async (req, res) => {
    const { symbol, period1, period2, interval } = req.body ?? {}
    if (!symbol || !period1 || !period2) {
      return res.status(400).json({ error: 'symbol, period1, and period2 are required' })
    }
    const intervalLabel = interval || '1d'
    const endTimer = marketDataFetchDuration.startTimer({ interval: intervalLabel })
    try {
      const bars = await fetchBars(symbol, { period1, period2, interval })
      endTimer({ outcome: 'success' })
      const count = await storeBars(db, bars)
      barsIngestedTotal.inc({ symbol: symbol.toUpperCase(), interval: intervalLabel }, count)
      res.json({ symbol: symbol.toUpperCase(), storedBars: count })
    } catch (err) {
      // Recorded too — an upstream that fails slowly is exactly what the latency panel
      // needs to show.
      endTimer({ outcome: 'error' })
      res.status(502).json({ error: err.message })
    }
  })

  router.get('/bars/:symbol', async (req, res) => {
    try {
      const bars = await loadBars(db, req.params.symbol, {
        start: req.query.start,
        end: req.query.end,
      })
      res.json({ symbol: req.params.symbol.toUpperCase(), bars })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
