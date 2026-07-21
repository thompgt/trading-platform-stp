import { Router } from 'express'
import { fetchBars, storeBars, loadBars, listCachedSymbols } from '../data/marketData.js'

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
    try {
      const bars = await fetchBars(symbol, { period1, period2, interval })
      const count = await storeBars(db, bars)
      res.json({ symbol: symbol.toUpperCase(), storedBars: count })
    } catch (err) {
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
