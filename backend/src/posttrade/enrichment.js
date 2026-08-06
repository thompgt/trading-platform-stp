/**
 * Middle office — trade capture and enrichment (workplan.md §3, steps 6-7).
 *
 * An execution as the front office knows it is four fields: time, side, quantity, price.
 * That is not a settleable trade. Before it can be instructed, someone has to attach the
 * things the front office never had to care about — which counterparty it faces, which
 * custodian account the stock moves through, what the commission and regulatory fees come
 * to, what the net cash amount is, and *when* that cash moves. Traditionally "someone" is
 * a person with a spreadsheet, and that is precisely the manual touchpoint STP removes.
 *
 * Two properties this module is built around:
 *
 *  - **Deterministic identity.** Trade IDs are derived from the run and the fill's ordinal
 *    position, not from a UUID or a clock. The same executions enriched twice produce
 *    byte-identical trades, which is what makes the whole procedure re-runnable and its
 *    PDF reproducible.
 *  - **Repair, not crash.** A fill that cannot be enriched — a bad price, a fractional
 *    quantity, no SSI on file — does not throw away the rest of the batch. It goes to a
 *    repair queue as a structured exception, the way it would land on an ops desk.
 */
import { notionalCents, applyRate, sumCents, toCents } from './money.js'
import { addBusinessDays, isoDate, startOfUtcDay } from './calendar.js'
import {
  BASE_CURRENCY,
  SETTLEMENT_CYCLE_DAYS,
  FIRM,
  FEE_SCHEDULE,
  EXECUTION_VENUE,
  CLEARING_HOUSE,
  DEFAULT_COUNTERPARTY_ID,
  lookupCounterparty,
  lookupSsi,
} from './staticData.js'

/**
 * Enrich a batch of raw fills into settleable trades.
 *
 * Returns both the enriched trades and a repair queue, in fill order. Callers get one
 * pass over the batch and a complete picture of what did and did not make it through.
 */
export function enrichTrades(fills, options = {}) {
  const {
    symbol,
    counterpartyId = DEFAULT_COUNTERPARTY_ID,
    currency = BASE_CURRENCY,
    account = FIRM.tradingAccount,
    feeSchedule = FEE_SCHEDULE,
    settlementCycleDays = SETTLEMENT_CYCLE_DAYS,
  } = options

  if (!symbol) {
    throw new Error('enrichTrades requires a symbol')
  }
  if (!Array.isArray(fills)) {
    throw new Error('enrichTrades requires an array of fills')
  }

  const ticker = String(symbol).toUpperCase()
  const trades = []
  const exceptions = []

  fills.forEach((fill, index) => {
    const sequence = index + 1
    try {
      trades.push(
        enrichTrade(fill, {
          symbol: ticker,
          sequence,
          counterpartyId,
          currency,
          account,
          feeSchedule,
          settlementCycleDays,
        }),
      )
    } catch (err) {
      exceptions.push({
        id: `RPR-${ticker}-${String(sequence).padStart(4, '0')}`,
        stage: 'enrichment',
        severity: 'high',
        reason: err.message,
        fill,
      })
    }
  })

  return { trades, exceptions }
}

/** Enrich a single fill. Throws on anything that would make the trade unsettleable. */
export function enrichTrade(fill, options) {
  const {
    symbol,
    sequence,
    counterpartyId = DEFAULT_COUNTERPARTY_ID,
    currency = BASE_CURRENCY,
    account = FIRM.tradingAccount,
    feeSchedule = FEE_SCHEDULE,
    settlementCycleDays = SETTLEMENT_CYCLE_DAYS,
  } = options

  const { side, qty, price, ts } = validateFill(fill)

  // Reference data first: a trade we cannot route is a trade we should not price.
  const counterparty = lookupCounterparty(counterpartyId)
  const ssi = lookupSsi(counterpartyId, currency)

  const executionTime = new Date(ts).toISOString()
  const tradeDate = isoDate(startOfUtcDay(ts))
  const settlementDate = isoDate(addBusinessDays(tradeDate, settlementCycleDays))

  const grossCents = notionalCents(qty, price)
  const fees = computeFees({ side, qty, grossCents, feeSchedule })

  // Buyer pays gross plus costs; seller receives gross less costs. Both totals are stated
  // positive — direction lives in `cashDirection`, never in the sign of an amount, so a
  // ledger posting can never silently flip by inheriting a negative.
  const netAmountCents = side === 'BUY' ? grossCents + fees.totalCents : grossCents - fees.totalCents

  return {
    tradeId: `TRD-${symbol}-${String(sequence).padStart(4, '0')}`,
    sequence,
    symbol,
    side,
    qty,
    price,
    currency,
    account,
    executionTime,
    tradeDate,
    settlementDate,
    settlementCycleDays,
    grossCents,
    commissionCents: fees.commissionCents,
    secFeeCents: fees.secFeeCents,
    tafFeeCents: fees.tafFeeCents,
    totalFeesCents: fees.totalCents,
    netAmountCents,
    cashDirection: side === 'BUY' ? 'PAY' : 'RECEIVE',
    counterparty: {
      id: counterparty.id,
      name: counterparty.name,
      lei: counterparty.lei,
      bic: counterparty.bic,
    },
    ssi: { ...ssi },
    venue: { ...EXECUTION_VENUE },
    clearingHouse: { ...CLEARING_HOUSE },
    status: 'ENRICHED',
  }
}

/**
 * Commission and regulatory fees for one fill.
 *
 * Both regulatory fees are sell-side only. The TAF is per share with a per-trade cap; the
 * SEC fee is a rate on notional. Commission is per share with a per-trade floor.
 */
export function computeFees({ side, qty, grossCents, feeSchedule = FEE_SCHEDULE }) {
  const commissionCents = Math.max(
    toCents(qty * feeSchedule.commissionPerShare),
    toCents(feeSchedule.commissionMinimum),
  )

  const secFeeCents = side === 'SELL' ? applyRate(grossCents, feeSchedule.secFeeRate) : 0
  const tafFeeCents =
    side === 'SELL'
      ? Math.min(toCents(qty * feeSchedule.tafPerShare), toCents(feeSchedule.tafMaximum))
      : 0

  return {
    commissionCents,
    secFeeCents,
    tafFeeCents,
    totalCents: sumCents([commissionCents, secFeeCents, tafFeeCents]),
  }
}

function validateFill(fill) {
  if (!fill || typeof fill !== 'object') {
    throw new Error('Fill is missing or not an object')
  }
  const side = String(fill.side ?? '').toUpperCase()
  if (side !== 'BUY' && side !== 'SELL') {
    throw new Error(`Side must be BUY or SELL, got: ${fill.side}`)
  }
  if (!Number.isInteger(fill.qty) || fill.qty <= 0) {
    throw new Error(`Quantity must be a positive whole number of shares, got: ${fill.qty}`)
  }
  if (!Number.isFinite(fill.price) || fill.price <= 0) {
    throw new Error(`Price must be a positive number, got: ${fill.price}`)
  }
  if (fill.ts == null || Number.isNaN(new Date(fill.ts).getTime())) {
    throw new Error(`Execution timestamp is missing or unparseable: ${fill.ts}`)
  }
  return { side, qty: fill.qty, price: fill.price, ts: fill.ts }
}
