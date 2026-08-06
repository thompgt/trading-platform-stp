import { describe, it, expect } from 'vitest'
import { enrichTrades } from '../src/posttrade/enrichment.js'
import { buildCounterpartyAdvices } from '../src/posttrade/counterpartyFeed.js'
import { matchTrades } from '../src/posttrade/matching.js'
import { createLedger, balanceOf, ACCOUNTS } from '../src/posttrade/ledger.js'
import { createBook } from '../src/posttrade/positions.js'
import { settleTrades } from '../src/posttrade/settlement.js'
import { buildCustodianStatement } from '../src/posttrade/custodianFeed.js'
import { reconcile } from '../src/posttrade/reconciliation.js'

const FILLS = [
  { ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: 500, price: 50.25 },
  { ts: '2025-03-06T14:30:00.000Z', side: 'SELL', qty: 200, price: 52.5 },
]

/** Run the batch through to settlement and hand back the books. */
function settled({ valuationDate = '2025-03-09', failedTradeIds = [] } = {}) {
  const ledger = createLedger({ openingCashCents: 10_000_000, openingDate: '2025-03-01' })
  const book = createBook()
  const { trades } = enrichTrades(FILLS, { symbol: 'AAPL' })
  const matched = matchTrades(trades, buildCounterpartyAdvices(trades)).trades
  settleTrades(matched, { ledger, book, valuationDate, failedTradeIds })
  return { ledger, book, valuationDate }
}

describe('reconcile', () => {
  it('reconciles clean when the custodian agrees', () => {
    const { ledger, book, valuationDate } = settled()
    const statement = buildCustodianStatement({ ledger, book, valuationDate })
    const result = reconcile({ ledger, book, statement })

    expect(result.reconciled).toBe(true)
    expect(result.breaks).toEqual([])
    expect(result.cash.status).toBe('MATCHED')
    expect(result.positions).toEqual([
      { symbol: 'AAPL', internalQty: 300, custodianQty: 300, deltaQty: 0, status: 'MATCHED' },
    ])
  })

  it('reports what it checked, so a clean recon is evidence rather than an empty array', () => {
    const { ledger, book, valuationDate } = settled()
    const statement = buildCustodianStatement({ ledger, book, valuationDate })
    const result = reconcile({ ledger, book, statement })
    expect(result.linesChecked).toBe(2) // cash + one position
    expect(result.statementId).toBe(statement.statementId)
    expect(result.asOf).toBe(valuationDate)
  })

  it('raises a cash break to the cent, with no tolerance', () => {
    const { ledger, book, valuationDate } = settled()
    const statement = buildCustodianStatement({
      ledger,
      book,
      valuationDate,
      discrepancies: { cashDeltaCents: -1 },
    })
    const result = reconcile({ ledger, book, statement })

    expect(result.reconciled).toBe(false)
    expect(result.cash).toMatchObject({ deltaCents: 1, status: 'BREAK' })
    expect(result.breaks[0]).toMatchObject({ id: 'REC-CASH', type: 'CASH_BREAK', severity: 'high' })
    expect(result.breaks[0].message).toMatch(/differs by 0\.01/)
  })

  it('raises a position break when share counts disagree', () => {
    const { ledger, book, valuationDate } = settled()
    const statement = buildCustodianStatement({
      ledger,
      book,
      valuationDate,
      discrepancies: { positionDeltas: { AAPL: -100 } },
    })
    const result = reconcile({ ledger, book, statement })

    expect(result.positions[0]).toMatchObject({ internalQty: 300, custodianQty: 200, deltaQty: 100 })
    expect(result.breaks[0]).toMatchObject({ id: 'REC-POS-AAPL', type: 'POSITION_BREAK' })
    expect(result.breaks[0].message).toMatch(/\+100 shares/)
  })

  it('catches a holding the custodian shows and we do not', () => {
    const { ledger, book, valuationDate } = settled()
    const statement = buildCustodianStatement({
      ledger,
      book,
      valuationDate,
      discrepancies: { positionDeltas: { MSFT: 50 } },
    })
    const result = reconcile({ ledger, book, statement })

    const msft = result.positions.find((p) => p.symbol === 'MSFT')
    expect(msft).toMatchObject({ internalQty: 0, custodianQty: 50, deltaQty: -50, status: 'BREAK' })
  })

  it('does not treat an unsettled or failed trade as a break', () => {
    // The sale fails to settle. Trade-date accounting leaves a receivable and moves no
    // cash, so our cash still agrees with the custodian's.
    const { ledger, book, valuationDate } = settled({ failedTradeIds: ['TRD-AAPL-0002'] })
    const statement = buildCustodianStatement({ ledger, book, valuationDate })
    const result = reconcile({ ledger, book, statement })

    expect(balanceOf(ledger, ACCOUNTS.CASH_RECEIVABLE)).toBeGreaterThan(0)
    expect(result.reconciled).toBe(true)
  })

  it('requires both sides of the comparison', () => {
    const { ledger, book, valuationDate } = settled()
    const statement = buildCustodianStatement({ ledger, book, valuationDate })
    expect(() => reconcile({ book, statement })).toThrow(/requires a ledger/)
    expect(() => reconcile({ ledger, statement })).toThrow(/requires a position book/)
    expect(() => reconcile({ ledger, book })).toThrow(/requires a custodian statement/)
  })
})

describe('buildCustodianStatement', () => {
  it('carries the custodian and account identifiers from the SSI', () => {
    const { ledger, book, valuationDate } = settled()
    const statement = buildCustodianStatement({ ledger, book, valuationDate })
    expect(statement).toMatchObject({
      custodian: 'Northgate Custody Bank N.A.',
      custodianBic: 'NGCBUS33XXX',
      securitiesAccount: 'SEC-88123401',
      cashAccount: 'CASH-88123401-USD',
      asOf: '2025-03-09',
    })
    expect(statement.statementId).toBe('CUST-SEC-88123401-2025-03-09')
  })
})
