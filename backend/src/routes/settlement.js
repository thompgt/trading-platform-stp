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
import { randomUUID } from 'node:crypto'
import { runSettlementProcedure } from '../posttrade/procedure.js'
import { renderSettlementReport } from '../posttrade/report.js'
import { getSessionExecutions } from './simulation.js'
import { ExpiringStore } from '../lib/expiringStore.js'
import { validate } from '../middleware/validate.js'
import { settlementRunBody } from '../schemas/requests.js'
import {
  settlementProcedureDuration,
  settlementReportsRenderedTotal,
  recordSettlementRun,
} from '../metrics/registry.js'

// Bounded for the same reason the session store is: a settlement run holds a full ledger,
// trade list and reconciliation, and an unauthenticated loop on POST /run would otherwise
// grow the process without limit. A dropped run is recoverable — the procedure is
// deterministic, so re-posting the same request reproduces it exactly.
const RUN_TTL_MS = Number(process.env.SETTLEMENT_RUN_TTL_MS ?? 6 * 60 * 60 * 1000)
const MAX_RUNS = Number(process.env.MAX_SETTLEMENT_RUNS ?? 100)

const runs = new ExpiringStore({ ttlMs: RUN_TTL_MS, maxEntries: MAX_RUNS })

/** Test-only: drop every stored run so cases do not observe each other's state. */
export function _resetSettlementRunsForTesting() {
  runs.clear()
}

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
  router.post('/run', validate(settlementRunBody), (req, res) => {
    const {
      sessionId = null,
      symbol: bodySymbol,
      fills: bodyFills,
      startingCash: bodyStartingCash,
      valuationDate = null,
      confirmDiscrepancies = {},
      failedTradeIds = [],
      custodianDiscrepancies = {},
    } = req.body

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
      })
    } catch (err) {
      endTimer()
      return res.status(400).json({ error: err.message })
    }
    endTimer()

    // The run id is minted here, never taken from the request. A caller-supplied id let one
    // request overwrite another's stored report, and even the procedure's own default
    // (STL-{ticker}-{asOf}) collides for two fill batches on the same symbol and date — so
    // the readable part is kept and a random suffix makes it unique per run.
    result.runId = `${result.runId}-${randomUUID().slice(0, 8)}`
    if (runs.has(result.runId)) {
      // Not reachable in practice; it is here so a future change that makes ids predictable
      // fails loudly instead of silently replacing a settlement record.
      return res.status(409).json({ error: `Settlement run already exists: ${result.runId}` })
    }
    runs.set(result.runId, { result, sessionId })
    recordSettlementRun(result.symbol, result)

    res.json(result)
  })

  /** Every run held in memory, newest work last — enough to find a run id. */
  router.get('/runs', (req, res) => {
    res.json({
      runs: [...runs].map(([runId, { result, sessionId }]) => ({
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

  /** Drop a run now rather than waiting for its TTL. */
  router.delete('/:runId', (req, res) => {
    if (!runs.delete(req.params.runId)) {
      return res.status(404).json({ error: `Unknown settlement run: ${req.params.runId}` })
    }
    res.json({ runId: req.params.runId, deleted: true })
  })

  return router
}
