import { describe, it, expect } from 'vitest'
import { enrichTrades } from '../src/posttrade/enrichment.js'
import { buildCounterpartyAdvices } from '../src/posttrade/counterpartyFeed.js'
import { matchTrades, compareToAdvice } from '../src/posttrade/matching.js'

const FILLS = [
  { ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: 500, price: 50.25 },
  { ts: '2025-03-06T14:30:00.000Z', side: 'SELL', qty: 500, price: 52.5 },
]

function enriched() {
  return enrichTrades(FILLS, { symbol: 'AAPL' }).trades
}

describe('matchTrades', () => {
  it('affirms trades that agree with the counterparty confirm', () => {
    const trades = enriched()
    const { trades: matched, breaks } = matchTrades(trades, buildCounterpartyAdvices(trades))
    expect(breaks).toEqual([])
    expect(matched.map((t) => t.status)).toEqual(['AFFIRMED', 'AFFIRMED'])
    expect(matched[0].matchStatus).toBe('MATCHED')
    expect(matched[0].adviceId).toBe('ADV-CPTY-001-0001')
  })

  it('breaks on a quantity mismatch and refuses to affirm', () => {
    const trades = enriched()
    const advices = buildCounterpartyAdvices(trades, {
      discrepancies: { 'TRD-AAPL-0002': { qty: 400 } },
    })
    const { trades: matched, breaks } = matchTrades(trades, advices)

    expect(matched[0].status).toBe('AFFIRMED')
    expect(matched[1].status).toBe('UNAFFIRMED')
    expect(matched[1].matchStatus).toBe('MISMATCH')

    expect(breaks).toHaveLength(1)
    expect(breaks[0]).toMatchObject({
      id: 'MTC-TRD-AAPL-0002',
      type: 'ECONOMIC_MISMATCH',
      severity: 'high',
      tradeId: 'TRD-AAPL-0002',
    })
    const qtyDiff = breaks[0].differences.find((d) => d.field === 'qty')
    expect(qtyDiff).toMatchObject({ ours: 500, theirs: 400, blocking: true })
  })

  it('recomputes the advice amount from the advice economics, so a quantity break moves the money too', () => {
    const trades = enriched()
    const advices = buildCounterpartyAdvices(trades, {
      discrepancies: { 'TRD-AAPL-0002': { qty: 400 } },
    })
    const { breaks } = matchTrades(trades, advices)
    expect(breaks[0].differences.some((d) => d.field === 'netAmountCents')).toBe(true)
  })

  it('raises a missing-advice break when no confirm arrives', () => {
    const trades = enriched()
    const advices = buildCounterpartyAdvices(trades, {
      discrepancies: { 'TRD-AAPL-0001': { missing: true } },
    })
    const { trades: matched, breaks } = matchTrades(trades, advices)

    expect(matched[0].status).toBe('UNAFFIRMED')
    expect(matched[0].matchStatus).toBe('NO_ADVICE')
    expect(matched[0].adviceId).toBeNull()
    expect(breaks[0]).toMatchObject({ type: 'MISSING_ADVICE', severity: 'high' })
  })

  it('escalates a confirm for a trade that is not in our blotter', () => {
    const trades = enriched()
    const advices = buildCounterpartyAdvices(trades)
    advices.push({ ...advices[0], adviceId: 'ADV-CPTY-001-0099', tradeRef: 'TRD-AAPL-0099' })

    const { breaks } = matchTrades(trades, advices)
    expect(breaks).toHaveLength(1)
    expect(breaks[0]).toMatchObject({
      type: 'UNEXPECTED_ADVICE',
      severity: 'high',
      tradeId: null,
      adviceId: 'ADV-CPTY-001-0099',
    })
  })

  it('never drops a trade, matched or not', () => {
    const trades = enriched()
    const advices = buildCounterpartyAdvices(trades, {
      discrepancies: { 'TRD-AAPL-0001': { missing: true }, 'TRD-AAPL-0002': { price: 99 } },
    })
    const { trades: matched } = matchTrades(trades, advices)
    expect(matched).toHaveLength(trades.length)
  })
})

describe('compareToAdvice', () => {
  const [trade] = enriched()
  const [advice] = buildCounterpartyAdvices([trade])

  it('finds no differences between identical records', () => {
    expect(compareToAdvice(trade, advice)).toEqual([])
  })

  it('tolerates a one-cent fee rounding difference on the net amount', () => {
    const offByOne = { ...advice, netAmountCents: advice.netAmountCents + 1 }
    expect(compareToAdvice(trade, offByOne)).toEqual([])
  })

  it('breaks once the amount difference exceeds tolerance', () => {
    const offByFive = { ...advice, netAmountCents: advice.netAmountCents + 5 }
    const diffs = compareToAdvice(trade, offByFive)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ field: 'netAmountCents', deltaCents: -5, blocking: true })
  })

  it('flags a settlement-date disagreement as blocking-but-not-economic', () => {
    const wrongDate = { ...advice, settlementDate: '2025-03-10' }
    const diffs = compareToAdvice(trade, wrongDate)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ field: 'settlementDate', blocking: false })
  })

  it('treats side, symbol and currency disagreements as economic', () => {
    for (const patch of [{ side: 'SELL' }, { symbol: 'MSFT' }, { currency: 'EUR' }]) {
      const diffs = compareToAdvice(trade, { ...advice, ...patch })
      expect(diffs.some((d) => d.blocking)).toBe(true)
    }
  })
})
