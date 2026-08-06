/**
 * Standing reference data for the post-trade stack.
 *
 * In a real firm none of this is code — it lives in a security master, a counterparty
 * master and an SSI (standing settlement instruction) database, maintained by a data team
 * and versioned because a wrong SSI routes cash to the wrong custodian. It is hardcoded
 * here because this platform settles paper trades, but it is kept in one module with the
 * same shape a real lookup would return, so the enrichment stage reads like the real one:
 * it *looks data up*, it does not invent it.
 *
 * Fee rates are the published US equity schedule in force at the time of writing. They are
 * rates, not amounts — the SEC revises the Section 31 rate annually, and a firm that
 * hardcodes the amount reconciles against the broker's number and finds a break.
 */

export const BASE_CURRENCY = 'USD'

/** T+1 for US equities since May 2024. */
export const SETTLEMENT_CYCLE_DAYS = 1

/** The firm's own identifiers — the "us" side of every confirm. */
export const FIRM = {
  legalEntity: 'STP Platform Securities LLC',
  lei: '5493001KJTIIGC8Y1R12',
  bic: 'STPPUS33XXX',
  tradingAccount: 'ACCT-EQ-001',
}

/**
 * Executing broker / counterparty. Every trade in this sandbox faces the same street-side
 * counterparty; the shape allows more.
 */
export const COUNTERPARTIES = {
  'CPTY-001': {
    id: 'CPTY-001',
    name: 'Meridian Clearing Partners LLC',
    lei: '549300XKZ3PQ8L2M4N88',
    bic: 'MERCUS33XXX',
    role: 'Executing broker / clearing counterparty',
  },
}

export const DEFAULT_COUNTERPARTY_ID = 'CPTY-001'

/**
 * Standing settlement instructions, keyed by (counterparty, currency). This is what tells
 * the settlement instruction where securities and cash actually move.
 */
export const SSI = {
  'CPTY-001:USD': {
    custodian: 'Northgate Custody Bank N.A.',
    custodianBic: 'NGCBUS33XXX',
    securitiesAccount: 'SEC-88123401',
    cashAccount: 'CASH-88123401-USD',
    placeOfSettlement: 'DTC',
    dtcParticipantId: '0157',
    method: 'DVP', // delivery versus payment — cash and stock move together or not at all
  },
}

/** Look up the SSI for a counterparty and currency, failing loudly if none is on file. */
export function lookupSsi(counterpartyId, currency = BASE_CURRENCY) {
  const ssi = SSI[`${counterpartyId}:${currency}`]
  if (!ssi) {
    throw new Error(`No SSI on file for ${counterpartyId} in ${currency}`)
  }
  return ssi
}

/** Look up a counterparty, failing loudly rather than settling against an unknown name. */
export function lookupCounterparty(counterpartyId) {
  const cpty = COUNTERPARTIES[counterpartyId]
  if (!cpty) {
    throw new Error(`Unknown counterparty: ${counterpartyId}`)
  }
  return cpty
}

/**
 * US equity commission and regulatory fee schedule.
 *
 * The two regulatory fees are sell-side only, which is the detail that most often makes a
 * naive net-amount recomputation disagree with the broker's.
 */
export const FEE_SCHEDULE = {
  commissionPerShare: 0.005, // $0.005/share
  commissionMinimum: 1.0, // per trade
  /** SEC Section 31 fee — sells only, on notional. */
  secFeeRate: 0.0000278,
  /** FINRA Trading Activity Fee — sells only, per share, capped per trade. */
  tafPerShare: 0.000166,
  tafMaximum: 8.3,
}

/** Market/venue defaults. Every fill in the replay is a single-venue lit execution. */
export const EXECUTION_VENUE = {
  mic: 'XNYS',
  name: 'New York Stock Exchange',
}

/** The clearing organization equity trades net down to before settlement. */
export const CLEARING_HOUSE = {
  name: 'National Securities Clearing Corporation',
  id: 'NSCC',
}
