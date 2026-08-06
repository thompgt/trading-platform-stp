/**
 * Back office — settlement and fails management (workplan.md §3 step 9, §4).
 *
 * This is the stage that actually moves money. For each affirmed trade it issues a
 * settlement instruction to the custodian, books the trade-date accounting entry, and — if
 * the settlement date has arrived and the instruction cleared — books the cash movement
 * against the payable or receivable.
 *
 * Three states a trade can be in on any given valuation date, and the distinction matters
 * because only one of them is a problem:
 *
 *  - `PENDING` — instructed, settlement date is still in the future. Normal.
 *  - `SETTLED` — cash and stock exchanged. Done.
 *  - `FAILED` — settlement date has passed and the instruction did not clear. This is the
 *    expensive one: fails carry funding cost, and past a threshold the counterparty can be
 *    bought in. Fails are aged in business days and escalated by age, not by count.
 *
 * A trade that never affirmed is `BLOCKED` and generates **no postings at all**. That is
 * the control: the ledger cannot contain a trade the two sides never agreed on, so a
 * matching break can never quietly become a cash movement.
 *
 * Everything is deterministic. Which trades fail is supplied by the caller (in production,
 * by the custodian's status feed), never rolled — a settlement report that produced
 * different fails on a re-run would be worthless as evidence.
 */
import { sumCents } from './money.js'
import { businessDaysBetween, isoDate, startOfUtcDay } from './calendar.js'
import { ACCOUNTS, postEntry } from './ledger.js'
import { applyBuy, applySell } from './positions.js'

/** Fails older than this many business days are escalated; past the buy-in threshold the
 *  counterparty is bought in. Both are quoted in business days because a fail does not age
 *  over a weekend the custodian is shut for. */
export const DEFAULT_FAILS_POLICY = {
  escalateAfterBusinessDays: 1,
  buyInAfterBusinessDays: 3,
}

/**
 * Settle a batch of matched trades as at a valuation date.
 *
 * `failedTradeIds` names the trades whose instruction did not clear — the custodian status
 * feed, in production. `valuationDate` defaults to the latest settlement date in the batch
 * so a historical replay settles fully rather than reporting everything as pending.
 */
export function settleTrades(trades, options = {}) {
  const {
    ledger,
    book,
    valuationDate = latestSettlementDate(trades),
    failedTradeIds = [],
    failsPolicy = DEFAULT_FAILS_POLICY,
  } = options

  if (!ledger) throw new Error('settleTrades requires a ledger')
  if (!book) throw new Error('settleTrades requires a position book')

  const failed = new Set(failedTradeIds)
  const asOf = valuationDate ? isoDate(startOfUtcDay(valuationDate)) : null

  const settled = []
  const instructions = []
  const fails = []
  const exceptions = []

  for (const trade of trades) {
    if (trade.status !== 'AFFIRMED') {
      exceptions.push({
        id: `STL-${trade.tradeId}`,
        stage: 'settlement',
        severity: 'high',
        tradeId: trade.tradeId,
        reason: `${trade.tradeId} was not affirmed (${trade.matchStatus ?? 'unknown'}) — not instructed, no postings made`,
      })
      settled.push({ ...trade, settlementStatus: 'BLOCKED', instructionId: null })
      continue
    }

    const instruction = buildInstruction(trade)
    instructions.push(instruction)

    // Trade-date accounting happens whether or not the trade settles on time — the
    // economics are ours from the moment we traded, and a fail is a cash-timing event,
    // not an un-trade.
    let tradeDateEntry
    try {
      tradeDateEntry = postTradeDateEntry(ledger, book, trade)
    } catch (err) {
      exceptions.push({
        id: `STL-${trade.tradeId}`,
        stage: 'settlement',
        severity: 'high',
        tradeId: trade.tradeId,
        reason: err.message,
      })
      settled.push({ ...trade, settlementStatus: 'BLOCKED', instructionId: instruction.instructionId })
      continue
    }

    const due = asOf != null && trade.settlementDate <= asOf
    if (!due) {
      settled.push({
        ...trade,
        settlementStatus: 'PENDING',
        instructionId: instruction.instructionId,
        entries: [tradeDateEntry.entryId],
      })
      continue
    }

    if (failed.has(trade.tradeId)) {
      const ageBusinessDays = businessDaysBetween(trade.settlementDate, asOf)
      const fail = buildFail(trade, ageBusinessDays, failsPolicy)
      fails.push(fail)
      settled.push({
        ...trade,
        settlementStatus: 'FAILED',
        instructionId: instruction.instructionId,
        entries: [tradeDateEntry.entryId],
        failId: fail.id,
      })
      continue
    }

    const settlementEntry = postSettlementEntry(ledger, trade)
    settled.push({
      ...trade,
      settlementStatus: 'SETTLED',
      settledOn: trade.settlementDate,
      instructionId: instruction.instructionId,
      entries: [tradeDateEntry.entryId, settlementEntry.entryId],
    })
  }

  return { trades: settled, instructions, fails, exceptions, valuationDate: asOf }
}

/**
 * The settlement instruction sent to the custodian.
 *
 * Modelled on the SWIFT securities settlement messages: MT541 receive-against-payment for a
 * purchase, MT543 deliver-against-payment for a sale. Both are DVP — cash and stock move
 * together or neither moves, which is what stops a fail from becoming a loss.
 */
export function buildInstruction(trade) {
  const receive = trade.side === 'BUY'
  return {
    instructionId: `SI-${trade.tradeId}`,
    messageType: receive ? 'MT541' : 'MT543',
    messageName: receive ? 'Receive against payment' : 'Deliver against payment',
    tradeId: trade.tradeId,
    symbol: trade.symbol,
    qty: trade.qty,
    settlementAmountCents: trade.netAmountCents,
    currency: trade.currency,
    tradeDate: trade.tradeDate,
    settlementDate: trade.settlementDate,
    deliveryDirection: receive ? 'RECEIVE' : 'DELIVER',
    cashDirection: trade.cashDirection,
    method: trade.ssi.method,
    placeOfSettlement: trade.ssi.placeOfSettlement,
    custodian: trade.ssi.custodian,
    custodianBic: trade.ssi.custodianBic,
    securitiesAccount: trade.ssi.securitiesAccount,
    cashAccount: trade.ssi.cashAccount,
    counterpartyBic: trade.counterparty.bic,
    status: 'INSTRUCTED',
  }
}

/**
 * Trade-date entry.
 *
 * Buy: the security and its costs are recognised, funded by a payable.
 * Sell: cost is relieved from the position book, the proceeds become a receivable, and the
 * difference between the two falls out as realised P&L — the plug that is not a plug.
 */
function postTradeDateEntry(ledger, book, trade) {
  const feeLines = [
    { account: ACCOUNTS.COMMISSION_EXPENSE, side: 'DR', amountCents: trade.commissionCents },
    {
      account: ACCOUNTS.REGULATORY_FEE_EXPENSE,
      side: 'DR',
      amountCents: sumCents([trade.secFeeCents, trade.tafFeeCents]),
    },
  ]

  if (trade.side === 'BUY') {
    applyBuy(book, trade.symbol, trade.qty, trade.grossCents)
    return postEntry(ledger, {
      date: trade.tradeDate,
      narrative: `Purchase ${trade.qty} ${trade.symbol} @ ${trade.price}`,
      reference: trade.tradeId,
      tradeId: trade.tradeId,
      lines: [
        { account: ACCOUNTS.SECURITIES, side: 'DR', amountCents: trade.grossCents },
        ...feeLines,
        { account: ACCOUNTS.CASH_PAYABLE, side: 'CR', amountCents: trade.netAmountCents },
      ],
    })
  }

  const { costReliefCents } = applySell(book, trade.symbol, trade.qty)
  const realisedCents = trade.grossCents - costReliefCents

  return postEntry(ledger, {
    date: trade.tradeDate,
    narrative: `Sale ${trade.qty} ${trade.symbol} @ ${trade.price}`,
    reference: trade.tradeId,
    tradeId: trade.tradeId,
    lines: [
      { account: ACCOUNTS.CASH_RECEIVABLE, side: 'DR', amountCents: trade.netAmountCents },
      ...feeLines,
      { account: ACCOUNTS.SECURITIES, side: 'CR', amountCents: costReliefCents },
      // A loss is a debit to the same P&L account, not a negative credit — amounts stay
      // positive everywhere and direction is carried by the side.
      realisedCents >= 0
        ? { account: ACCOUNTS.REALISED_PNL, side: 'CR', amountCents: realisedCents }
        : { account: ACCOUNTS.REALISED_PNL, side: 'DR', amountCents: -realisedCents },
    ],
  })
}

/** Settlement-date entry: the payable or receivable is cleared against actual cash. */
function postSettlementEntry(ledger, trade) {
  const buy = trade.side === 'BUY'
  return postEntry(ledger, {
    date: trade.settlementDate,
    narrative: `Settle ${buy ? 'purchase' : 'sale'} ${trade.qty} ${trade.symbol} (DVP, ${trade.ssi.placeOfSettlement})`,
    reference: `SI-${trade.tradeId}`,
    tradeId: trade.tradeId,
    lines: buy
      ? [
          { account: ACCOUNTS.CASH_PAYABLE, side: 'DR', amountCents: trade.netAmountCents },
          { account: ACCOUNTS.CASH, side: 'CR', amountCents: trade.netAmountCents },
        ]
      : [
          { account: ACCOUNTS.CASH, side: 'DR', amountCents: trade.netAmountCents },
          { account: ACCOUNTS.CASH_RECEIVABLE, side: 'CR', amountCents: trade.netAmountCents },
        ],
  })
}

/** Age a fail and decide what happens to it next. */
function buildFail(trade, ageBusinessDays, policy) {
  const buyInEligible = ageBusinessDays >= policy.buyInAfterBusinessDays
  const escalated = ageBusinessDays >= policy.escalateAfterBusinessDays

  return {
    id: `FAIL-${trade.tradeId}`,
    stage: 'settlement',
    tradeId: trade.tradeId,
    symbol: trade.symbol,
    side: trade.side,
    qty: trade.qty,
    amountCents: trade.netAmountCents,
    settlementDate: trade.settlementDate,
    ageBusinessDays,
    severity: buyInEligible ? 'high' : escalated ? 'medium' : 'low',
    action: buyInEligible
      ? 'BUY_IN'
      : escalated
        ? 'ESCALATE_TO_OPS'
        : 'RETRY',
    message: buyInEligible
      ? `${trade.tradeId} has failed for ${ageBusinessDays} business days — past the buy-in threshold, escalate to Ops for counterparty buy-in`
      : escalated
        ? `${trade.tradeId} failed to settle on ${trade.settlementDate} and is ${ageBusinessDays} business days old — escalate to Ops`
        : `${trade.tradeId} failed to settle on ${trade.settlementDate} — retrying within the automated window`,
  }
}

function latestSettlementDate(trades) {
  let latest = null
  for (const trade of trades) {
    if (trade.settlementDate && (latest == null || trade.settlementDate > latest)) {
      latest = trade.settlementDate
    }
  }
  return latest
}
