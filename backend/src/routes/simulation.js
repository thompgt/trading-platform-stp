import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { loadBars } from '../data/marketData.js'
import { SimulationEngine } from '../simulation/engine.js'
import { STRATEGY_KINDS } from '../simulation/strategyRunner.js'
import { evaluateRisk } from '../agents/riskEngine.js'
import { draftComplianceTriage } from '../agents/complianceAgent.js'
import { LlmValidationError } from '../agents/llmJson.js'

// In-memory session store. Fine for a single-instance demo/paper-trading server; a real
// deployment would move this to a shared store (workplan.md §8 notes horizontal scaling
// for the production agents — this replay sandbox is intentionally simpler).
const sessions = new Map()

function getSession(id) {
  const session = sessions.get(id)
  if (!session) {
    const err = new Error(`Unknown simulation session: ${id}`)
    err.status = 404
    throw err
  }
  return session
}

export function simulationRouter(db) {
  const router = Router()

  router.post('/start', async (req, res) => {
    const { symbol, start, end, strategy, startingCash } = req.body ?? {}
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' })
    }
    if (strategy && !STRATEGY_KINDS.includes(strategy.kind)) {
      return res.status(400).json({ error: `strategy.kind must be one of ${STRATEGY_KINDS.join(', ')}` })
    }

    try {
      const bars = await loadBars(db, symbol, { start, end })
      if (bars.length === 0) {
        return res.status(404).json({
          error: `No cached bars for ${symbol} in that range — call POST /api/data/fetch first`,
        })
      }
      const engine = new SimulationEngine(bars, { strategy, startingCash })
      const id = randomUUID()
      sessions.set(id, { engine, symbol: symbol.toUpperCase() })
      res.json({ sessionId: id, symbol: symbol.toUpperCase(), ...engine.state() })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/:id/state', (req, res) => {
    try {
      const { engine, symbol } = getSession(req.params.id)
      res.json({ sessionId: req.params.id, symbol, ...engine.state() })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  router.post('/:id/step', (req, res) => {
    try {
      const { engine, symbol } = getSession(req.params.id)
      const n = Number.isFinite(req.body?.n) ? req.body.n : 1
      const state = engine.step(n)
      res.json({ sessionId: req.params.id, symbol, ...state })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  router.post('/:id/rewind', (req, res) => {
    try {
      const { engine, symbol } = getSession(req.params.id)
      const n = Number.isFinite(req.body?.n) ? req.body.n : 1
      const state = engine.rewind(n)
      res.json({ sessionId: req.params.id, symbol, ...state })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  router.post('/:id/jump', (req, res) => {
    const { date } = req.body ?? {}
    if (!date) {
      return res.status(400).json({ error: 'date is required' })
    }
    try {
      const { engine, symbol } = getSession(req.params.id)
      const state = engine.jumpToDate(date)
      res.json({ sessionId: req.params.id, symbol, ...state })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  router.post('/:id/reset', (req, res) => {
    try {
      const { engine, symbol } = getSession(req.params.id)
      const state = engine.reset()
      res.json({ sessionId: req.params.id, symbol, ...state })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  router.get('/:id/risk', (req, res) => {
    try {
      const { engine, symbol } = getSession(req.params.id)
      const state = engine.state()
      const currentPrice = state.currentBar?.close ?? null
      const alerts = evaluateRisk({
        symbol,
        cash: state.cash,
        position: state.position,
        currentPrice,
        startingCash: engine.startingCash,
        equityCurve: state.equityCurve,
      })
      res.json({ sessionId: req.params.id, symbol, alerts })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  router.get('/:id/compliance', async (req, res) => {
    try {
      const { engine, symbol } = getSession(req.params.id)
      const state = engine.state()
      const drafts = await draftComplianceTriage({ symbol, trades: state.trades })
      res.json({ sessionId: req.params.id, symbol, drafts })
    } catch (err) {
      if (err instanceof LlmValidationError) {
        return res.status(502).json({ error: err.message, kind: 'llm_validation_failed' })
      }
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  router.put('/:id/strategy', (req, res) => {
    const { strategy } = req.body ?? {}
    if (!strategy || !STRATEGY_KINDS.includes(strategy.kind)) {
      return res.status(400).json({ error: `strategy.kind must be one of ${STRATEGY_KINDS.join(', ')}` })
    }
    try {
      const { engine, symbol } = getSession(req.params.id)
      const state = engine.setStrategy(strategy)
      res.json({ sessionId: req.params.id, symbol, ...state })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  return router
}
