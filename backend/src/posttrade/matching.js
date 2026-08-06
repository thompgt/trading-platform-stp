/**
 * Middle office — confirmation and affirmation (workplan.md §3 step 7, §4).
 *
 * Before a trade can be instructed for settlement, both sides have to agree on what the
 * trade *is*. Our record and the counterparty's confirm are compared field by field; if
 * they agree the trade is affirmed and flows on untouched, and if they do not it stops
 * here — which is the whole point. An unaffirmed trade that settles anyway is how a firm
 * ends up paying the wrong amount to the right counterparty and finding out at recon.
 *
 * Three shapes of disagreement, deliberately treated differently:
 *
 *  - **Economic** (symbol, side, quantity, price) — no tolerance at all. There is no such
 *    thing as approximately the right number of shares.
 *  - **Money** (net amount) — a small tolerance, because both sides recompute fees from
 *    published rates and can legitimately land a cent apart on a rounding tie. Anything
 *    beyond the tolerance is a break.
 *  - **Presence** (advice missing, or one we never traded) — the trade is simply not
 *    affirmable, and an unexpected advice is escalated rather than ignored.
 *
 * Nothing here calls a model. Matching is a comparison; if it were fuzzy it would not be
 * a control.
 */

export const DEFAULT_TOLERANCES = {
  /** Cents of allowed difference on the net settlement amount (fee rounding only). */
  netAmountCents: 2,
}

const ECONOMIC_FIELDS = [
  { field: 'symbol', label: 'Symbol' },
  { field: 'side', label: 'Side' },
  { field: 'qty', label: 'Quantity' },
  { field: 'price', label: 'Price' },
]

/**
 * Match enriched trades against counterparty advices.
 *
 * Returns the trades with an affirmation status attached, plus the breaks. Trades are
 * never dropped: an unmatched trade comes back with status `UNAFFIRMED` so the settlement
 * stage can refuse it explicitly rather than by omission.
 */
export function matchTrades(trades, advices, { tolerances = DEFAULT_TOLERANCES } = {}) {
  const byRef = new Map()
  for (const advice of advices) {
    byRef.set(advice.tradeRef, advice)
  }

  const breaks = []
  const matched = trades.map((trade) => {
    const advice = byRef.get(trade.tradeId)
    byRef.delete(trade.tradeId)

    if (!advice) {
      breaks.push({
        id: `MTC-${trade.tradeId}`,
        stage: 'matching',
        type: 'MISSING_ADVICE',
        severity: 'high',
        tradeId: trade.tradeId,
        message: `No counterparty confirm received for ${trade.tradeId} — cannot affirm`,
        differences: [],
      })
      return { ...trade, status: 'UNAFFIRMED', matchStatus: 'NO_ADVICE', adviceId: null }
    }

    const differences = compareToAdvice(trade, advice, tolerances)
    if (differences.length === 0) {
      return {
        ...trade,
        status: 'AFFIRMED',
        matchStatus: 'MATCHED',
        adviceId: advice.adviceId,
        affirmedAt: advice.receivedAt,
      }
    }

    breaks.push({
      id: `MTC-${trade.tradeId}`,
      stage: 'matching',
      type: 'ECONOMIC_MISMATCH',
      severity: differences.some((d) => d.blocking) ? 'high' : 'medium',
      tradeId: trade.tradeId,
      adviceId: advice.adviceId,
      message: `${trade.tradeId} does not match confirm ${advice.adviceId} on ${differences
        .map((d) => d.label.toLowerCase())
        .join(', ')}`,
      differences,
    })

    return { ...trade, status: 'UNAFFIRMED', matchStatus: 'MISMATCH', adviceId: advice.adviceId }
  })

  // Anything left in the map is a confirm for a trade we have no record of — the more
  // alarming direction of the two, since it may be someone else's trade booked to us.
  for (const orphan of byRef.values()) {
    breaks.push({
      id: `MTC-${orphan.adviceId}`,
      stage: 'matching',
      type: 'UNEXPECTED_ADVICE',
      severity: 'high',
      tradeId: null,
      adviceId: orphan.adviceId,
      message: `Confirm ${orphan.adviceId} references ${orphan.tradeRef}, which is not in our blotter`,
      differences: [],
    })
  }

  return { trades: matched, breaks }
}

/** Field-by-field comparison of our record against theirs. */
export function compareToAdvice(trade, advice, tolerances = DEFAULT_TOLERANCES) {
  const differences = []

  for (const { field, label } of ECONOMIC_FIELDS) {
    if (trade[field] !== advice[field]) {
      differences.push({
        field,
        label,
        ours: trade[field],
        theirs: advice[field],
        blocking: true,
      })
    }
  }

  if (trade.currency !== advice.currency) {
    differences.push({
      field: 'currency',
      label: 'Currency',
      ours: trade.currency,
      theirs: advice.currency,
      blocking: true,
    })
  }

  // A settlement-date disagreement is not an economic break, but instructing on it would
  // guarantee a fail — so it blocks affirmation without being flagged as a wrong trade.
  if (trade.settlementDate !== advice.settlementDate) {
    differences.push({
      field: 'settlementDate',
      label: 'Settlement date',
      ours: trade.settlementDate,
      theirs: advice.settlementDate,
      blocking: false,
    })
  }

  const amountDelta = trade.netAmountCents - advice.netAmountCents
  if (Math.abs(amountDelta) > tolerances.netAmountCents) {
    differences.push({
      field: 'netAmountCents',
      label: 'Net amount',
      ours: trade.netAmountCents,
      theirs: advice.netAmountCents,
      deltaCents: amountDelta,
      blocking: true,
    })
  }

  return differences
}
