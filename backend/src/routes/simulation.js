import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { loadBars } from '../data/marketData.js'
import { SimulationEngine } from '../simulation/engine.js'
import { STRATEGY_KINDS } from '../simulation/strategyRunner.js'
import { computePerformance, inferPeriodsPerYear } from '../analytics/performance.js'
import { evaluateRisk } from '../agents/riskEngine.js'
import { draftComplianceTriage } from '../agents/complianceAgent.js'
import { LlmValidationError } from '../agents/llmJson.js'
import {
  simulationSessionsStarted,
  simulationSessionsActive,
  simulationActionsTotal,
  riskAlertsTotal,
  complianceDraftsTotal,
  recordSessionPerformance,
} from '../metrics/registry.js'

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

/**
 * A read-only view of a session's executions, for the post-trade procedure to settle.
 *
 * Deliberately narrow: the settlement router gets the fills, the symbol and the opening
 * cash, and no handle on the engine. Post-trade must never be able to reach back and
 * change the trading history it is settling — the front office decides what was traded,
 * the back office decides what it costs and when it pays.
 */
export function getSessionExecutions(id) {
  const session = sessions.get(id)
  if (!session) return null
  const state = session.engine.state()
  return {
    symbol: session.symbol,
    startingCash: session.engine.startingCash,
    fills: state.trades.map(({ ts, side, qty, price }) => ({ ts, side, qty, price })),
  }
}

/** Performance summary for a session's current state, with bar size inferred from its bars. */
function performanceOf({ engine }, state) {
  return computePerformance({
    equityCurve: state.equityCurve,
    trades: state.trades,
    startingCash: engine.startingCash,
    periodsPerYear: inferPeriodsPerYear(engine.bars),
  })
}

/**
 * Push the session's current P&L/drawdown/exposure onto the Prometheus gauges after every
 * control action, so Grafana charts the replay as it happens rather than only when
 * someone opens the performance endpoint.
 */
function publishSessionMetrics(session, state) {
  try {
    recordSessionPerformance(session.symbol, performanceOf(session, state))
  } catch {
    // Metrics must never break a trading action. A gap in a dashboard is recoverable;
    // a 500 on /step is not.
  }
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
      const session = { engine, symbol: symbol.toUpperCase() }
      sessions.set(id, session)
      simulationSessionsStarted.inc({ symbol: session.symbol })
      simulationSessionsActive.set(sessions.size)
      const state = engine.state()
      publishSessionMetrics(session, state)
      res.json({ sessionId: id, symbol: session.symbol, ...state })
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
      const session = getSession(req.params.id)
      const n = Number.isFinite(req.body?.n) ? req.body.n : 1
      const state = session.engine.step(n)
      simulationActionsTotal.inc({ action: 'step' })
      publishSessionMetrics(session, state)
      res.json({ sessionId: req.params.id, symbol: session.symbol, ...state })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  router.post('/:id/rewind', (req, res) => {
    try {
      const session = getSession(req.params.id)
      const n = Number.isFinite(req.body?.n) ? req.body.n : 1
      const state = session.engine.rewind(n)
      simulationActionsTotal.inc({ action: 'rewind' })
      publishSessionMetrics(session, state)
      res.json({ sessionId: req.params.id, symbol: session.symbol, ...state })
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
      const session = getSession(req.params.id)
      const state = session.engine.jumpToDate(date)
      simulationActionsTotal.inc({ action: 'jump' })
      publishSessionMetrics(session, state)
      res.json({ sessionId: req.params.id, symbol: session.symbol, ...state })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  router.post('/:id/reset', (req, res) => {
    try {
      const session = getSession(req.params.id)
      const state = session.engine.reset()
      simulationActionsTotal.inc({ action: 'reset' })
      publishSessionMetrics(session, state)
      res.json({ sessionId: req.params.id, symbol: session.symbol, ...state })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  router.get('/:id/performance', (req, res) => {
    try {
      const session = getSession(req.params.id)
      const state = session.engine.state()
      const performance = performanceOf(session, state)
      recordSessionPerformance(session.symbol, performance)
      res.json({ sessionId: req.params.id, symbol: session.symbol, performance })
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
      for (const alert of alerts) {
        riskAlertsTotal.inc({ severity: alert.severity, agent: alert.agent })
      }
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
      for (const draft of drafts) {
        complianceDraftsTotal.inc({ severity: draft.severity })
      }
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
      const session = getSession(req.params.id)
      const state = session.engine.setStrategy(strategy)
      simulationActionsTotal.inc({ action: 'strategy_change' })
      publishSessionMetrics(session, state)
      res.json({ sessionId: req.params.id, symbol: session.symbol, ...state })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  return router
}
