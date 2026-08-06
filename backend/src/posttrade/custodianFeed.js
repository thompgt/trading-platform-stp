/**
 * The custodian's statement of record.
 *
 * In production this is an inbound end-of-day file — an MT535 holdings statement and an
 * MT950 cash statement, or a custodian API. Here it is derived from our own settled
 * postings, which would make reconciliation vacuous if that were the end of it, so the
 * caller can inject discrepancies to represent the thing recon exists to find: the
 * custodian disagreeing with us.
 *
 * Kept out of `reconciliation.js` for the same structural reason the counterparty advice
 * generator is kept out of the matcher — a reconciler that can synthesize the statement it
 * reconciles against is not a control, it is a mirror.
 */
import { balanceOf, ACCOUNTS } from './ledger.js'
import { snapshot } from './positions.js'
import { FIRM, lookupSsi, DEFAULT_COUNTERPARTY_ID } from './staticData.js'

/**
 * Build the custodian statement as at a valuation date.
 *
 * `discrepancies` may carry `cashDeltaCents` (custodian shows more or less cash than we do)
 * and `positionDeltas` keyed by symbol (custodian shows a different share count).
 */
export function buildCustodianStatement({
  ledger,
  book,
  valuationDate,
  counterpartyId = DEFAULT_COUNTERPARTY_ID,
  discrepancies = {},
} = {}) {
  const ssi = lookupSsi(counterpartyId)
  const { cashDeltaCents = 0, positionDeltas = {} } = discrepancies

  const positions = snapshot(book)
    .map(({ symbol, qty }) => ({ symbol, qty: qty + (positionDeltas[symbol] ?? 0) }))
    .filter((position) => position.qty !== 0)

  // A symbol the custodian shows that we hold none of — the more alarming direction, and
  // one a delta on an existing position cannot express.
  for (const [symbol, delta] of Object.entries(positionDeltas)) {
    if (!positions.some((p) => p.symbol === symbol) && delta !== 0) {
      positions.push({ symbol, qty: delta })
    }
  }

  return {
    statementId: `CUST-${ssi.securitiesAccount}-${valuationDate}`,
    custodian: ssi.custodian,
    custodianBic: ssi.custodianBic,
    accountHolder: FIRM.legalEntity,
    securitiesAccount: ssi.securitiesAccount,
    cashAccount: ssi.cashAccount,
    asOf: valuationDate,
    cashBalanceCents: balanceOf(ledger, ACCOUNTS.CASH) + cashDeltaCents,
    positions: positions.sort((a, b) => a.symbol.localeCompare(b.symbol)),
  }
}
