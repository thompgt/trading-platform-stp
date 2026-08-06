import { describe, it, expect } from 'vitest'
import { enrichTrades, enrichTrade, computeFees } from '../src/posttrade/enrichment.js'

// Sized so the per-share commission clears the $1.00 per-trade floor — a 100-share ticket
// pays the minimum, which would hide the rate.
const BUY = { ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: 500, price: 50.25 }
const SELL = { ts: '2025-03-06T14:30:00.000Z', side: 'SELL', qty: 500, price: 52.5 }

describe('enrichTrade', () => {
  it('attaches counterparty, SSI, venue and clearing house from reference data', () => {
    const trade = enrichTrade(BUY, { symbol: 'AAPL', sequence: 1 })
    expect(trade.counterparty.name).toBe('Meridian Clearing Partners LLC')
    expect(trade.ssi.custodian).toBe('Northgate Custody Bank N.A.')
    expect(trade.ssi.method).toBe('DVP')
    expect(trade.venue.mic).toBe('XNYS')
    expect(trade.clearingHouse.id).toBe('NSCC')
  })

  it('derives a deterministic trade id from symbol and sequence', () => {
    expect(enrichTrade(BUY, { symbol: 'AAPL', sequence: 7 }).tradeId).toBe('TRD-AAPL-0007')
    expect(enrichTrade(BUY, { symbol: 'AAPL', sequence: 7 })).toEqual(
      enrichTrade(BUY, { symbol: 'AAPL', sequence: 7 }),
    )
  })

  it('settles T+1 on the exchange calendar', () => {
    const trade = enrichTrade(BUY, { symbol: 'AAPL', sequence: 1 })
    expect(trade.tradeDate).toBe('2025-03-05')
    expect(trade.settlementDate).toBe('2025-03-06')

    // Friday trade -> Monday settlement.
    const friday = enrichTrade({ ...BUY, ts: '2025-03-07T14:30:00.000Z' }, { symbol: 'AAPL', sequence: 1 })
    expect(friday.settlementDate).toBe('2025-03-10')
  })

  it('adds costs to the amount a buyer pays', () => {
    const trade = enrichTrade(BUY, { symbol: 'AAPL', sequence: 1 })
    expect(trade.grossCents).toBe(2512500)
    expect(trade.commissionCents).toBe(250) // 500 shares x $0.005
    expect(trade.secFeeCents).toBe(0) // buys pay no regulatory fees
    expect(trade.tafFeeCents).toBe(0)
    expect(trade.netAmountCents).toBe(2512750)
    expect(trade.cashDirection).toBe('PAY')
  })

  it('deducts costs from the amount a seller receives, including regulatory fees', () => {
    const trade = enrichTrade(SELL, { symbol: 'AAPL', sequence: 2 })
    expect(trade.grossCents).toBe(2625000)
    expect(trade.commissionCents).toBe(250)
    expect(trade.secFeeCents).toBe(73) // 26,250.00 x 0.0000278, to the cent
    expect(trade.tafFeeCents).toBe(8) // 500 x $0.000166
    expect(trade.totalFeesCents).toBe(331)
    expect(trade.netAmountCents).toBe(2625000 - 331)
    expect(trade.cashDirection).toBe('RECEIVE')
  })

  it('states every amount positive, leaving direction to cashDirection', () => {
    for (const trade of [enrichTrade(BUY, { symbol: 'X', sequence: 1 }), enrichTrade(SELL, { symbol: 'X', sequence: 2 })]) {
      expect(trade.grossCents).toBeGreaterThan(0)
      expect(trade.netAmountCents).toBeGreaterThan(0)
      expect(trade.totalFeesCents).toBeGreaterThanOrEqual(0)
    }
  })

  it('applies the commission floor to a tiny trade', () => {
    const trade = enrichTrade({ ...BUY, qty: 10 }, { symbol: 'AAPL', sequence: 1 })
    expect(trade.commissionCents).toBe(100) // $1.00 minimum beats 10 x $0.005
  })

  it('caps the trading activity fee on a very large sell', () => {
    const fees = computeFees({ side: 'SELL', qty: 1_000_000, grossCents: 100_000_000 })
    expect(fees.tafFeeCents).toBe(830) // $8.30 cap
  })
})

describe('enrichTrades', () => {
  it('enriches a batch in order with sequential ids', () => {
    const { trades, exceptions } = enrichTrades([BUY, SELL], { symbol: 'msft' })
    expect(exceptions).toEqual([])
    expect(trades.map((t) => t.tradeId)).toEqual(['TRD-MSFT-0001', 'TRD-MSFT-0002'])
    expect(trades[0].symbol).toBe('MSFT')
    expect(trades[0].status).toBe('ENRICHED')
  })

  it('routes an unenrichable fill to the repair queue without losing the batch', () => {
    const { trades, exceptions } = enrichTrades([BUY, { ...SELL, qty: 1.5 }, SELL], { symbol: 'AAPL' })
    expect(trades).toHaveLength(2)
    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]).toMatchObject({ id: 'RPR-AAPL-0002', stage: 'enrichment', severity: 'high' })
    expect(exceptions[0].reason).toMatch(/whole number of shares/)
  })

  it('repairs rather than throws on bad prices, sides and timestamps', () => {
    const bad = [
      { ...BUY, price: 0 },
      { ...BUY, side: 'HOLD' },
      { ...BUY, ts: 'never' },
      null,
    ]
    const { trades, exceptions } = enrichTrades(bad, { symbol: 'AAPL' })
    expect(trades).toEqual([])
    expect(exceptions.map((e) => e.reason)).toEqual([
      expect.stringMatching(/Price must be a positive number/),
      expect.stringMatching(/Side must be BUY or SELL/),
      expect.stringMatching(/unparseable/),
      expect.stringMatching(/missing or not an object/),
    ])
  })

  it('rejects a batch with no symbol or a non-array input', () => {
    expect(() => enrichTrades([BUY], {})).toThrow(/requires a symbol/)
    expect(() => enrichTrades('nope', { symbol: 'AAPL' })).toThrow(/array of fills/)
  })

  it('fails loudly when no SSI is on file for the counterparty', () => {
    const { exceptions } = enrichTrades([BUY], { symbol: 'AAPL', counterpartyId: 'CPTY-999' })
    expect(exceptions[0].reason).toMatch(/Unknown counterparty/)
  })
})
