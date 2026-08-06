/**
 * Back office — the position book, on average cost.
 *
 * The ledger knows there are securities worth $X at cost; it does not know they are 500
 * shares of AAPL. This does, and it is what lets a sale relieve the right amount of cost
 * and book the difference as realised P&L instead of leaving the two to be plugged.
 *
 * Average cost rather than lot-by-lot (FIFO/specific-ID) is a deliberate simplification —
 * this book has no tax reporting to do, and average cost cannot disagree with itself about
 * which lot was sold. The one thing it must not do is leak cents: a partial sale relieves a
 * *rounded* share of the cost pool, so a full liquidation relieves whatever remains rather
 * than recomputing, which guarantees the pool lands on exactly zero.
 */
import { roundHalfUp } from './money.js'

/** An empty book. Positions appear as they are bought and vanish when fully sold. */
export function createBook() {
  return { positions: new Map() }
}

/** Add shares at cost. Cost includes only the security cost, never commission. */
export function applyBuy(book, symbol, qty, costCents) {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error(`Buy quantity must be a positive whole number, got: ${qty}`)
  }
  const current = book.positions.get(symbol) ?? { qty: 0, costCents: 0 }
  const next = { qty: current.qty + qty, costCents: current.costCents + costCents }
  book.positions.set(symbol, next)
  return { ...next }
}

/**
 * Relieve cost for a sale, returning the cost released.
 *
 * Selling more than the book holds is refused rather than allowed to go short: this
 * platform's strategies are long-only, so a short position is a symptom of a lost or
 * duplicated buy, and silently booking it would hide the real problem.
 */
export function applySell(book, symbol, qty) {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error(`Sell quantity must be a positive whole number, got: ${qty}`)
  }
  const current = book.positions.get(symbol)
  if (!current || current.qty < qty) {
    throw new Error(
      `Cannot sell ${qty} ${symbol}: position is ${current?.qty ?? 0} — settling this would go short`,
    )
  }

  // Full liquidation relieves the remaining pool exactly, so rounding on earlier partial
  // sales cannot strand a cent in a position of zero shares.
  const costReliefCents =
    current.qty === qty ? current.costCents : roundHalfUp((current.costCents * qty) / current.qty)

  const remaining = { qty: current.qty - qty, costCents: current.costCents - costReliefCents }
  if (remaining.qty === 0) book.positions.delete(symbol)
  else book.positions.set(symbol, remaining)

  return { costReliefCents, remaining: { ...remaining } }
}

/** Current holding for a symbol. */
export function positionOf(book, symbol) {
  const position = book.positions.get(symbol) ?? { qty: 0, costCents: 0 }
  return { ...position }
}

/** Every open position, symbol order, with average cost per share for display. */
export function snapshot(book) {
  return [...book.positions.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, position]) => ({
      symbol,
      qty: position.qty,
      costCents: position.costCents,
      averageCostCents: position.qty === 0 ? 0 : roundHalfUp(position.costCents / position.qty),
    }))
}
