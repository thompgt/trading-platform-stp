import { describe, it, expect } from 'vitest'
import { createBook, applyBuy, applySell, positionOf, snapshot } from '../src/posttrade/positions.js'

describe('position book', () => {
  it('accumulates quantity and cost across buys', () => {
    const book = createBook()
    applyBuy(book, 'AAPL', 100, 500000)
    applyBuy(book, 'AAPL', 100, 600000)
    expect(positionOf(book, 'AAPL')).toEqual({ qty: 200, costCents: 1100000 })
  })

  it('relieves cost pro rata on a partial sale', () => {
    const book = createBook()
    applyBuy(book, 'AAPL', 200, 1100000)
    const { costReliefCents, remaining } = applySell(book, 'AAPL', 50)
    expect(costReliefCents).toBe(275000)
    expect(remaining).toEqual({ qty: 150, costCents: 825000 })
  })

  it('relieves exactly the remaining pool on a full liquidation', () => {
    // 3 shares at a cost that does not divide evenly — partial sales round, so the final
    // sale must clear whatever is left rather than recomputing.
    const book = createBook()
    applyBuy(book, 'AAPL', 3, 1000)
    const first = applySell(book, 'AAPL', 1)
    expect(first.costReliefCents).toBe(333)
    const second = applySell(book, 'AAPL', 2)
    expect(second.costReliefCents).toBe(667)
    expect(first.costReliefCents + second.costReliefCents).toBe(1000)
    expect(positionOf(book, 'AAPL')).toEqual({ qty: 0, costCents: 0 })
  })

  it('drops a position once it is fully sold', () => {
    const book = createBook()
    applyBuy(book, 'AAPL', 100, 500000)
    applySell(book, 'AAPL', 100)
    expect(book.positions.has('AAPL')).toBe(false)
    expect(snapshot(book)).toEqual([])
  })

  it('refuses to go short rather than silently booking a negative position', () => {
    const book = createBook()
    applyBuy(book, 'AAPL', 50, 250000)
    expect(() => applySell(book, 'AAPL', 100)).toThrow(/would go short/)
    expect(() => applySell(book, 'MSFT', 1)).toThrow(/position is 0/)
    expect(positionOf(book, 'AAPL').qty).toBe(50) // unchanged by the refused sale
  })

  it('rejects non-positive or fractional quantities', () => {
    const book = createBook()
    expect(() => applyBuy(book, 'AAPL', 0, 100)).toThrow(/positive whole number/)
    expect(() => applyBuy(book, 'AAPL', 1.5, 100)).toThrow(/positive whole number/)
    expect(() => applySell(book, 'AAPL', -1)).toThrow(/positive whole number/)
  })

  it('reports open positions in symbol order with average cost', () => {
    const book = createBook()
    applyBuy(book, 'MSFT', 10, 40000)
    applyBuy(book, 'AAPL', 100, 500000)
    expect(snapshot(book)).toEqual([
      { symbol: 'AAPL', qty: 100, costCents: 500000, averageCostCents: 5000 },
      { symbol: 'MSFT', qty: 10, costCents: 40000, averageCostCents: 4000 },
    ])
  })
})
