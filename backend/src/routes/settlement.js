/**
 * Post-trade API — run the settlement procedure and read what it produced.
 *
 * The route layer is thin on purpose: it validates input, calls
 * `runSettlementProcedure`, keeps the result, and serves views of it. No settlement logic
 * lives here, so the procedure can be run from a test, a scheduler or a CLI without going
 * through HTTP.
 *
 * Runs are held in memory alongside the replay sessions they came from. A real deployment
 * would persist them — a settlement report is a record with a retention requirement, not a
 * cache entry — but the procedure is deterministic, so a lost run can be recreated exactly
 * by re-posting the same request.
 */
import { Router } from 'express'
import { runSettlementProcedure } from '../posttrade/procedure.js'
import { renderSettlementReport } from '../posttrade/report.js'
import { getSessionExecutions } from './simulation.js'
import {
  settlementProcedureDuration,
  settlementReportsRenderedTotal,
  recordSettlementRun,
} from '../metrics/registry.js'

const runs = new Map()

function getRun(id) {
  const run = runs.get(id)
  if (!run) {
    const err = new Error(`Unknown settlement run: ${id}`)
    err.status = 404
    throw err
  }
  return run
}

export function settlementRouter() {
  const router = Router()

  /**
   * Run the procedure.
   *
   * Fills come either straight from the request or from a replay session — the same code
   * path either way, which is the point: the paper-trading sandbox settles through exactly
   * the pipeline a live desk would.
   */
  router.post('/run', (req, res) => {
    const {
      sessionId = null,
      symbol: bodySymbol,
      fills: bodyFills,
      startingCash: bodyStartingCash,
      valuationDate = null,
      confirmDiscrepancies = {},
      failedTradeIds = [],
      custodianDiscrepancies = {},
      runId = null,
    } = req.body ?? {}

    let symbol = bodySymbol
    let fills = bodyFills
    let startingCash = bodyStartingCash

    if (sessionId) {
      const session = getSessionExecutions(sessionId)
      if (!session) {
        return res.status(404).json({ error: `Unknown simulation session: ${sessionId}` })
      }
      symbol = symbol ?? session.symbol
      fills = fills ?? session.fills
      startingCash = startingCash ?? session.startingCash
    }

    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required (or a sessionId to take it from)' })
    }
    if (!Array.isArray(fills)) {
      return res.status(400).json({ error: 'fills must be an array (or supply a sessionId)' })
    }

    const endTimer = settlementProcedureDuration.startTimer({ symbol: String(symbol).toUpperCase() })
    let result
    try {
      result = runSettlementProcedure({
        symbol,
        fills,
        startingCash: startingCash ?? 0,
        valuationDate,
        confirmDiscrepancies,
        failedTradeIds,
        custodianDiscrepancies,
        runId,
      })
    } catch (err) {
      endTimer()
      return res.status(400).json({ error: err.message })
    }
    endTimer()

    runs.set(result.runId, { result, sessionId })
    recordSettlementRun(result.symbol, result)

    res.json(result)
  })

  /** Every run held in memory, newest work last — enough to find a run id. */
  router.get('/runs', (req, res) => {
    res.json({
      runs: [...runs.entries()].map(([runId, { result, sessionId }]) => ({
        runId,
        sessionId,
        symbol: result.symbol,
        valuationDate: result.valuationDate,
        generatedAt: result.generatedAt,
        summary: result.summary,
      })),
    })
  })

  router.get('/:runId', (req, res) => {
    try {
      res.json(getRun(req.params.runId).result)
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  /** The cash ledger, trial balance and account balances — the accounting view. */
  router.get('/:runId/ledger', (req, res) => {
    try {
      const { result } = getRun(req.params.runId)
      res.json({
        runId: result.runId,
        symbol: result.symbol,
        valuationDate: result.valuationDate,
        cash: result.ledger.cash,
        balances: result.ledger.balances,
        trialBalance: result.ledger.trialBalance,
        entries: result.ledger.entries,
        positions: result.positions,
      })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  /** Everything a human has to look at, in one place — the ops queue. */
  router.get('/:runId/breaks', (req, res) => {
    try {
      const { result } = getRun(req.params.runId)
      res.json({
        runId: result.runId,
        symbol: result.symbol,
        exceptions: result.exceptions,
        fails: result.fails,
        reconciliation: {
          reconciled: result.reconciliation.reconciled,
          breaks: result.reconciliation.breaks,
        },
      })
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  /** The settlement report as a PDF. */
  router.get('/:runId/report.pdf', (req, res) => {
    try {
      const { result } = getRun(req.params.runId)
      const pdf = renderSettlementReport(result)
      settlementReportsRenderedTotal.inc({ symbol: result.symbol })

      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Length', pdf.length)
      // `inline` so a browser previews it; the filename still applies on download.
      res.setHeader('Content-Disposition', `inline; filename="${result.runId}.pdf"`)
      res.send(pdf)
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message })
    }
  })

  return router
}
