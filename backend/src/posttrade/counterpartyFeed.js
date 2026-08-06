/**
 * The counterparty's side of the trade.
 *
 * Affirmation is only meaningful if the two records being compared come from two places.
 * In production this module is replaced by an inbound broker confirm feed (a CTM/ALERT
 * central-matching message, a FIX 35=AK confirmation, or a start-of-day file). Here it
 * synthesizes what the counterparty would have sent, so the matching engine has a genuine
 * second record to disagree with.
 *
 * It lives apart from `matching.js` on purpose: **the matching engine must never be able to
 * manufacture the other side of a trade.** If a matcher can invent its counterparty's
 * record, "100% affirmed" means nothing. Keeping the generator in a separate module makes
 * that separation structural rather than a comment.
 *
 * Discrepancies are injected explicitly by the caller, never randomly — a report that shows
 * a break has to show the same break when it is re-run.
 */
import { notionalCents, sumCents } from './money.js'
import { computeFees } from './enrichment.js'

/**
 * Build the counterparty advice for each enriched trade.
 *
 * `discrepancies` maps a trade ID to a patch applied to that advice, e.g.
 * `{ 'TRD-AAPL-0002': { qty: 400 } }` for a quantity mismatch, or
 * `{ 'TRD-AAPL-0003': { missing: true } }` for an advice that never arrived.
 */
export function buildCounterpartyAdvices(trades, { discrepancies = {} } = {}) {
  const advices = []

  for (const trade of trades) {
    const patch = discrepancies[trade.tradeId] ?? {}
    if (patch.missing) continue

    const advice = {
      adviceId: `ADV-${trade.counterparty.id}-${String(trade.sequence).padStart(4, '0')}`,
      tradeRef: trade.tradeId,
      counterpartyId: trade.counterparty.id,
      symbol: patch.symbol ?? trade.symbol,
      // The counterparty is on the opposite side economically, but a confirm is stated from
      // *our* perspective — it says "we confirm you bought" — so the side matches ours.
      side: patch.side ?? trade.side,
      qty: patch.qty ?? trade.qty,
      price: patch.price ?? trade.price,
      currency: patch.currency ?? trade.currency,
      tradeDate: patch.tradeDate ?? trade.tradeDate,
      settlementDate: patch.settlementDate ?? trade.settlementDate,
      receivedAt: trade.executionTime,
    }

    // Recompute the money from the advice's own economics rather than copying ours —
    // otherwise a quantity break would arrive with our net amount attached and the
    // amount comparison would agree when it should not.
    advice.netAmountCents = patch.netAmountCents ?? adviceNetAmount(advice)
    advices.push(advice)
  }

  return advices
}

function adviceNetAmount(advice) {
  const grossCents = notionalCents(advice.qty, advice.price)
  const fees = computeFees({ side: advice.side, qty: advice.qty, grossCents })
  return advice.side === 'BUY'
    ? sumCents([grossCents, fees.totalCents])
    : grossCents - fees.totalCents
}
