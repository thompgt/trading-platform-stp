import { describe, it, expect } from 'vitest'
import { runSettlementProcedure } from '../src/posttrade/procedure.js'
import { ACCOUNTS } from '../src/posttrade/ledger.js'

const FILLS = [
  { ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: 500, price: 50.25 },
  { ts: '2025-03-06T14:30:00.000Z', side: 'SELL', qty: 200, price: 52.5 },
  { ts: '2025-03-07T14:30:00.000Z', side: 'SELL', qty: 300, price: 49.8 },
]

function run(overrides = {}) {
  return runSettlementProcedure({
    symbol: 'AAPL',
    fills: FILLS,
    startingCash: 100000,
    valuationDate: '2025-03-12',
    generatedAt: '2025-03-12T22:00:00.000Z',
    ...overrides,
  })
}

describe('runSettlementProcedure', () => {
  it('takes fills all the way to settled with no human touchpoint', () => {
    const result = run()
    expect(result.summary.capturedCount).toBe(3)
    expect(result.summary.settledCount).toBe(3)
    expect(result.summary.stpRatePct).toBe(100)
    expect(result.summary.exceptionCount).toBe(0)
    expect(result.exceptions).toEqual([])
  })

  it('reports every stage with its desk, throughput and exception count', () => {
    const result = run()
    expect(result.stages.map((s) => s.name)).toEqual([
      'Trade capture',
      'Enrichment',
      'Confirmation matching',
      'Settlement (DVP)',
      'Custodian reconciliation',
    ])
    expect(result.stages.map((s) => s.desk)).toEqual([
      'Middle office',
      'Middle office',
      'Middle office',
      'Back office',
      'Back office',
    ])
    expect(result.stages.every((s) => s.status === 'CLEAN')).toBe(true)
  })

  it('keeps the books in balance and reconciled', () => {
    const result = run()
    expect(result.summary.inBalance).toBe(true)
    expect(result.summary.reconciled).toBe(true)
    expect(result.ledger.trialBalance.totalDebitsCents).toBe(
      result.ledger.trialBalance.totalCreditsCents,
    )
  })

  it('produces a cash ledger whose closing balance ties to the ledger', () => {
    const result = run()
    const cash = result.ledger.cash
    expect(cash.lines[0].narrative).toBe('Opening cash balance')
    expect(cash.lines[0].balanceCents).toBe(10_000_000)
    expect(cash.closingBalanceCents).toBe(result.summary.closingCashCents)

    // Opening cash plus the net of everything that actually settled.
    expect(cash.closingBalanceCents).toBe(10_000_000 + result.summary.netCashMovementCents)
  })

  it('books realised P&L across both sales', () => {
    const result = run()
    // 200 sold at 52.50 and 300 at 49.80, against a 50.25 average cost.
    const expected = 200 * (52.5 - 50.25) * 100 + 300 * (49.8 - 50.25) * 100
    expect(result.summary.realisedPnlCents).toBe(Math.round(expected))
    expect(result.positions).toEqual([]) // fully flat
  })

  it('is reproducible — same fills in, byte-identical result out', () => {
    expect(run()).toEqual(run())
  })

  it('derives a stable run id from the symbol and valuation date', () => {
    expect(run().runId).toBe('STL-AAPL-20250312')
    expect(run({ runId: 'CUSTOM-1' }).runId).toBe('CUSTOM-1')
  })

  it('leaves later trades pending when the valuation date is early', () => {
    const result = run({ valuationDate: '2025-03-06' })
    expect(result.summary.settledCount).toBe(1)
    expect(result.summary.pendingCount).toBe(2)
    expect(result.summary.stpRatePct).toBeCloseTo(33.33, 1)
    expect(result.summary.openReceivableCents).toBeGreaterThan(0)
  })
})

describe('exception handling', () => {
  it('drops a bad ticket to the exception queue without holding up the batch', () => {
    const result = run({ fills: [FILLS[0], { ...FILLS[1], qty: 1.5 }, FILLS[2]] })
    expect(result.summary.capturedCount).toBe(3)
    expect(result.summary.enrichedCount).toBe(2)
    expect(result.summary.settledCount).toBe(2)
    expect(result.exceptions).toHaveLength(1)
    expect(result.exceptions[0].stage).toBe('enrichment')
    expect(result.stages[1].status).toBe('EXCEPTIONS')
  })

  it('keeps trade ids tied to the executions as booked, not to the survivors', () => {
    // The second ticket is unenrichable, so no trade carries id 0002 — and the third
    // ticket keeps 0003 rather than sliding up to fill the gap. An id that shifted when an
    // earlier ticket was repaired would make every reference to it ambiguous.
    const result = run({ fills: [FILLS[0], { ...FILLS[1], qty: 1.5 }, FILLS[2]] })
    expect(result.trades.map((t) => t.tradeId)).toEqual(['TRD-AAPL-0001', 'TRD-AAPL-0003'])
    expect(result.exceptions[0].id).toBe('RPR-AAPL-0002')
  })

  it('blocks a trade the counterparty does not agree with, and makes no postings for it', () => {
    const result = run({ confirmDiscrepancies: { 'TRD-AAPL-0002': { qty: 100 } } })
    const blocked = result.trades.find((t) => t.tradeId === 'TRD-AAPL-0002')

    expect(blocked.status).toBe('UNAFFIRMED')
    expect(blocked.settlementStatus).toBe('BLOCKED')
    expect(result.ledger.entries.every((e) => e.tradeId !== 'TRD-AAPL-0002')).toBe(true)
    expect(result.summary.stpRatePct).toBeLessThan(100)
    expect(result.summary.inBalance).toBe(true) // the books still balance
  })

  it('ages and escalates a settlement fail', () => {
    const result = run({ failedTradeIds: ['TRD-AAPL-0001'] })
    expect(result.summary.failedCount).toBe(1)
    expect(result.fails[0]).toMatchObject({ tradeId: 'TRD-AAPL-0001', action: 'BUY_IN' })
    // The failed purchase never paid, so the payable is still open.
    expect(result.summary.openPayableCents).toBeGreaterThan(0)
  })

  it('raises a custodian break without touching the internal books', () => {
    const result = run({ custodianDiscrepancies: { cashDeltaCents: 250 } })
    expect(result.summary.reconciled).toBe(false)
    expect(result.reconciliation.breaks[0].type).toBe('CASH_BREAK')
    expect(result.summary.inBalance).toBe(true)
    expect(result.stages[4].status).toBe('EXCEPTIONS')
  })

  it('collects exceptions from every stage into one queue', () => {
    const result = run({
      fills: [FILLS[0], { ...FILLS[1], price: -1 }, FILLS[2]],
      // The second ticket never enriches, and the third keeps its ordinal — IDs track the
      // executions as booked, not the survivors.
      confirmDiscrepancies: { 'TRD-AAPL-0003': { qty: 1 } },
      custodianDiscrepancies: { positionDeltas: { AAPL: 10 } },
    })
    const stages = new Set(result.exceptions.map((e) => e.stage))
    expect(stages.has('enrichment')).toBe(true)
    expect(stages.has('matching')).toBe(true)
    expect(stages.has('reconciliation')).toBe(true)
    expect(result.summary.exceptionCount).toBe(result.exceptions.length)
  })
})

describe('procedure output', () => {
  it('carries the instruction set that was sent to the custodian', () => {
    const result = run()
    expect(result.instructions).toHaveLength(3)
    expect(result.instructions[0]).toMatchObject({ messageType: 'MT541', method: 'DVP' })
    expect(result.instructions[1].messageType).toBe('MT543')
  })

  it('carries the custodian statement it reconciled against', () => {
    const result = run()
    expect(result.custodianStatement.asOf).toBe('2025-03-12')
    expect(result.custodianStatement.custodian).toBe('Northgate Custody Bank N.A.')
  })

  it('exposes the balances behind the summary', () => {
    const result = run()
    const cashRow = result.ledger.balances.find((b) => b.code === ACCOUNTS.CASH)
    expect(cashRow.balanceCents).toBe(result.summary.closingCashCents)
    expect(result.summary.journalEntryCount).toBe(result.ledger.entries.length)
  })

  it('requires a symbol', () => {
    expect(() => runSettlementProcedure({ fills: FILLS })).toThrow(/requires a symbol/)
  })

  it('handles an empty batch without dividing by zero', () => {
    const result = run({ fills: [] })
    expect(result.summary.stpRatePct).toBe(0)
    expect(result.summary.inBalance).toBe(true)
    expect(result.summary.reconciled).toBe(true)
  })
})
