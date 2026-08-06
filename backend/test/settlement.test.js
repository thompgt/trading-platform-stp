import { describe, it, expect } from 'vitest'
import { enrichTrades } from '../src/posttrade/enrichment.js'
import { buildCounterpartyAdvices } from '../src/posttrade/counterpartyFeed.js'
import { matchTrades } from '../src/posttrade/matching.js'
import { createLedger, balanceOf, trialBalance, ACCOUNTS } from '../src/posttrade/ledger.js'
import { createBook, positionOf } from '../src/posttrade/positions.js'
import { settleTrades, buildInstruction } from '../src/posttrade/settlement.js'

const FILLS = [
  { ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: 500, price: 50.25 },
  { ts: '2025-03-06T14:30:00.000Z', side: 'SELL', qty: 500, price: 52.5 },
]

/** Enrich and affirm a batch, optionally injecting confirm discrepancies. */
function affirmed(discrepancies = {}) {
  const { trades } = enrichTrades(FILLS, { symbol: 'AAPL' })
  const advices = buildCounterpartyAdvices(trades, { discrepancies })
  return matchTrades(trades, advices).trades
}

function books(openingCashCents = 10_000_000) {
  return { ledger: createLedger({ openingCashCents, openingDate: '2025-03-01' }), book: createBook() }
}

describe('settleTrades', () => {
  it('settles affirmed trades and moves cash on settlement date', () => {
    const { ledger, book } = books()
    const result = settleTrades(affirmed(), { ledger, book })

    expect(result.trades.map((t) => t.settlementStatus)).toEqual(['SETTLED', 'SETTLED'])
    expect(result.fails).toEqual([])
    expect(result.exceptions).toEqual([])

    // Buy 2,512,750 out, sell 2,624,669 in.
    expect(balanceOf(ledger, ACCOUNTS.CASH)).toBe(10_000_000 - 2512750 + 2624669)
    expect(balanceOf(ledger, ACCOUNTS.CASH_PAYABLE)).toBe(0)
    expect(balanceOf(ledger, ACCOUNTS.CASH_RECEIVABLE)).toBe(0)
    expect(trialBalance(ledger).inBalance).toBe(true)
  })

  it('books two entries per settled trade and one for an unsettled one', () => {
    const { ledger, book } = books()
    const result = settleTrades(affirmed(), { ledger, book, valuationDate: '2025-03-06' })
    const [buy, sell] = result.trades
    expect(buy.settlementStatus).toBe('SETTLED')
    expect(buy.entries).toHaveLength(2)
    expect(sell.settlementStatus).toBe('PENDING') // settles 2025-03-07
    expect(sell.entries).toHaveLength(1)
  })

  it('relieves the position and books realised P&L on the sale', () => {
    const { ledger, book } = books()
    settleTrades(affirmed(), { ledger, book })
    expect(positionOf(book, 'AAPL')).toEqual({ qty: 0, costCents: 0 })
    // Sold 500 at 52.50 against a 50.25 cost: 2,625,000 - 2,512,500.
    expect(balanceOf(ledger, ACCOUNTS.REALISED_PNL)).toBe(112500)
    expect(balanceOf(ledger, ACCOUNTS.SECURITIES)).toBe(0)
  })

  it('books a loss as a debit to the same P&L account', () => {
    const { ledger, book } = books()
    const { trades } = enrichTrades(
      [FILLS[0], { ...FILLS[1], price: 48 }],
      { symbol: 'AAPL' },
    )
    settleTrades(matchTrades(trades, buildCounterpartyAdvices(trades)).trades, { ledger, book })
    expect(balanceOf(ledger, ACCOUNTS.REALISED_PNL)).toBe(2400000 - 2512500)
    expect(trialBalance(ledger).inBalance).toBe(true)
  })

  it('leaves an open payable when settlement date has not arrived', () => {
    const { ledger, book } = books()
    settleTrades(affirmed(), { ledger, book, valuationDate: '2025-03-05' })
    expect(balanceOf(ledger, ACCOUNTS.CASH)).toBe(10_000_000) // untouched on trade date
    expect(balanceOf(ledger, ACCOUNTS.CASH_PAYABLE)).toBe(2512750)
  })

  it('makes no postings at all for a trade that never affirmed', () => {
    const { ledger, book } = books()
    const trades = affirmed({ 'TRD-AAPL-0001': { qty: 400 } })
    const result = settleTrades(trades, { ledger, book })

    const blocked = result.trades.find((t) => t.tradeId === 'TRD-AAPL-0001')
    expect(blocked.settlementStatus).toBe('BLOCKED')
    expect(blocked.instructionId).toBeNull()
    expect(result.instructions.map((i) => i.tradeId)).not.toContain('TRD-AAPL-0001')
    expect(ledger.entries.every((e) => e.tradeId !== 'TRD-AAPL-0001')).toBe(true)
    expect(result.exceptions[0].reason).toMatch(/not affirmed/)
  })

  it('ages a fail in business days and escalates by age', () => {
    const { ledger, book } = books()
    const result = settleTrades(affirmed(), {
      ledger,
      book,
      valuationDate: '2025-03-07',
      failedTradeIds: ['TRD-AAPL-0001'],
    })

    const fail = result.fails[0]
    expect(fail).toMatchObject({
      id: 'FAIL-TRD-AAPL-0001',
      tradeId: 'TRD-AAPL-0001',
      settlementDate: '2025-03-06',
      ageBusinessDays: 1,
      action: 'ESCALATE_TO_OPS',
      severity: 'medium',
    })
    // Failed cash never moved, but the trade-date payable is still on the books.
    expect(balanceOf(ledger, ACCOUNTS.CASH_PAYABLE)).toBe(2512750)
  })

  it('flags a stale fail for buy-in', () => {
    const { ledger, book } = books()
    const result = settleTrades(affirmed(), {
      ledger,
      book,
      valuationDate: '2025-03-11',
      failedTradeIds: ['TRD-AAPL-0001'],
    })
    expect(result.fails[0]).toMatchObject({ ageBusinessDays: 3, action: 'BUY_IN', severity: 'high' })
  })

  it('retries silently inside the automated window', () => {
    const { ledger, book } = books()
    const result = settleTrades(affirmed(), {
      ledger,
      book,
      valuationDate: '2025-03-06',
      failedTradeIds: ['TRD-AAPL-0001'],
    })
    expect(result.fails[0]).toMatchObject({ ageBusinessDays: 0, action: 'RETRY', severity: 'low' })
  })

  it('raises an exception rather than going short when a sale has no position behind it', () => {
    const { ledger, book } = books()
    const { trades } = enrichTrades([FILLS[1]], { symbol: 'AAPL' })
    const result = settleTrades(matchTrades(trades, buildCounterpartyAdvices(trades)).trades, {
      ledger,
      book,
    })
    expect(result.trades[0].settlementStatus).toBe('BLOCKED')
    expect(result.exceptions[0].reason).toMatch(/would go short/)
    expect(trialBalance(ledger).inBalance).toBe(true)
  })

  it('requires a ledger and a book', () => {
    expect(() => settleTrades([], { book: createBook() })).toThrow(/requires a ledger/)
    expect(() => settleTrades([], { ledger: createLedger() })).toThrow(/requires a position book/)
  })
})

describe('buildInstruction', () => {
  const [buy, sell] = affirmed()

  it('issues a receive-against-payment instruction for a purchase', () => {
    expect(buildInstruction(buy)).toMatchObject({
      instructionId: 'SI-TRD-AAPL-0001',
      messageType: 'MT541',
      deliveryDirection: 'RECEIVE',
      cashDirection: 'PAY',
      method: 'DVP',
      placeOfSettlement: 'DTC',
      status: 'INSTRUCTED',
    })
  })

  it('issues a deliver-against-payment instruction for a sale', () => {
    expect(buildInstruction(sell)).toMatchObject({
      messageType: 'MT543',
      deliveryDirection: 'DELIVER',
      cashDirection: 'RECEIVE',
    })
  })

  it('carries the custodian account details from the SSI', () => {
    const instruction = buildInstruction(buy)
    expect(instruction.custodianBic).toBe('NGCBUS33XXX')
    expect(instruction.securitiesAccount).toBe('SEC-88123401')
    expect(instruction.cashAccount).toBe('CASH-88123401-USD')
  })
})
