/**
 * Back office — reconciliation (workplan.md §3 step 10).
 *
 * The last control in the chain, and the one that catches everything the earlier ones
 * missed. Matching proves we agree with the counterparty about the trade; reconciliation
 * proves we agree with the custodian about the *result* — that the cash we think we have is
 * the cash sitting in the account, and the shares we think we own are the shares held for
 * us.
 *
 * A break here is a real break. There is no tolerance on either side: a share is a share,
 * and cash reconciles to the cent or it does not reconcile. A firm that adds a tolerance to
 * a cash recon has, in effect, decided how much money it is willing to lose without
 * noticing.
 *
 * One thing that is deliberately *not* a break: an unsettled or failed trade. Trade-date
 * accounting books those to a payable or receivable and moves no cash, so our cash balance
 * already agrees with the custodian's. That is exactly why the ledger separates trade-date
 * recognition from settlement-date cash movement — done the other way, every fail would
 * light up recon and the real breaks would be lost in the noise.
 */
import { balanceOf, ACCOUNTS } from './ledger.js'
import { snapshot } from './positions.js'
import { formatCents } from './money.js'

/**
 * Reconcile internal books against a custodian statement.
 *
 * Returns a per-line comparison alongside the breaks, so a clean recon is evidence of
 * having checked rather than an empty array that could equally mean nothing ran.
 */
export function reconcile({ ledger, book, statement }) {
  if (!ledger) throw new Error('reconcile requires a ledger')
  if (!book) throw new Error('reconcile requires a position book')
  if (!statement) throw new Error('reconcile requires a custodian statement')

  const breaks = []

  const internalCashCents = balanceOf(ledger, ACCOUNTS.CASH)
  const custodianCashCents = statement.cashBalanceCents
  const cashDeltaCents = internalCashCents - custodianCashCents

  const cash = {
    line: 'Cash',
    account: statement.cashAccount,
    internalCents: internalCashCents,
    custodianCents: custodianCashCents,
    deltaCents: cashDeltaCents,
    status: cashDeltaCents === 0 ? 'MATCHED' : 'BREAK',
  }

  if (cashDeltaCents !== 0) {
    breaks.push({
      id: 'REC-CASH',
      stage: 'reconciliation',
      type: 'CASH_BREAK',
      severity: 'high',
      symbol: null,
      message: `Cash account ${statement.cashAccount} differs by ${formatCents(cashDeltaCents)} — books ${formatCents(internalCashCents)}, custodian ${formatCents(custodianCashCents)}`,
      deltaCents: cashDeltaCents,
    })
  }

  // Union of both sides: a position only we have and one only they have are both breaks,
  // and iterating either side alone would miss one of them.
  const internalPositions = new Map(snapshot(book).map((p) => [p.symbol, p.qty]))
  const custodianPositions = new Map(statement.positions.map((p) => [p.symbol, p.qty]))
  const symbols = [...new Set([...internalPositions.keys(), ...custodianPositions.keys()])].sort()

  const positions = symbols.map((symbol) => {
    const internalQty = internalPositions.get(symbol) ?? 0
    const custodianQty = custodianPositions.get(symbol) ?? 0
    const deltaQty = internalQty - custodianQty

    if (deltaQty !== 0) {
      breaks.push({
        id: `REC-POS-${symbol}`,
        stage: 'reconciliation',
        type: 'POSITION_BREAK',
        severity: 'high',
        symbol,
        message: `${symbol} position differs by ${deltaQty > 0 ? '+' : ''}${deltaQty} shares — books ${internalQty}, custodian ${custodianQty}`,
        deltaQty,
      })
    }

    return {
      symbol,
      internalQty,
      custodianQty,
      deltaQty,
      status: deltaQty === 0 ? 'MATCHED' : 'BREAK',
    }
  })

  return {
    asOf: statement.asOf,
    statementId: statement.statementId,
    custodian: statement.custodian,
    cash,
    positions,
    breaks,
    linesChecked: positions.length + 1,
    reconciled: breaks.length === 0,
  }
}
