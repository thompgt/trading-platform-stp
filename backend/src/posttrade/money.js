/**
 * Money as integer minor units (cents).
 *
 * The front office can afford floats — an equity curve that is a hundredth of a cent off
 * changes no decision. The back office cannot: a cash ledger has to balance to the cent,
 * and `0.1 + 0.2 !== 0.3` is how a settlement break gets born. So everything downstream of
 * trade capture converts to integer cents once, at the boundary, and stays there until it
 * is formatted for a human.
 *
 * Rounding is half-up away from zero — the convention a broker confirm uses, so our
 * recomputation of their fee matches theirs instead of drifting by a cent on ties.
 */

/** Convert a decimal amount (e.g. 123.455) to integer minor units (12346). */
export function toCents(amount) {
  if (!Number.isFinite(amount)) {
    throw new Error(`Cannot convert non-finite amount to cents: ${amount}`)
  }
  return roundHalfUp(scale(amount))
}

/** Convert integer minor units back to a decimal amount, for display or JSON. */
export function fromCents(cents) {
  assertInteger(cents)
  return cents / 100
}

/**
 * Notional of a fill in cents. Quantity is a whole number of shares and price is a decimal
 * quote, so this is the one place the two representations meet.
 */
export function notionalCents(qty, price) {
  if (!Number.isInteger(qty)) {
    throw new Error(`Quantity must be a whole number of shares: ${qty}`)
  }
  return roundHalfUp(scale(qty * price))
}

/**
 * Multiply by 100 and collapse binary representation error before rounding.
 *
 * `1.005 * 100` is 100.49999999999999 in IEEE-754, which rounds *down* — a decimal that
 * sits exactly on a half-cent tie loses the tie it should win. Fixing the product to 6
 * decimal places (far below any meaningful precision in a price or a fee rate) restores
 * the tie so `roundHalfUp` sees the number the trader typed rather than the one the
 * hardware stored.
 */
function scale(amount) {
  return Number((amount * 100).toFixed(6))
}

/** Sum of integer cent amounts. Kept explicit so a stray float can't sneak into a total. */
export function sumCents(values) {
  let total = 0
  for (const value of values) {
    assertInteger(value)
    total += value
  }
  return total
}

/**
 * Apply a rate (e.g. a 0.0000278 regulatory fee) to a cent amount, rounding to the cent.
 * Fee schedules are quoted as decimal rates, so this is deliberately the only multiplication
 * of money by a non-integer in the post-trade stack.
 */
export function applyRate(cents, rate) {
  assertInteger(cents)
  return roundHalfUp(Number((cents * rate).toFixed(6)))
}

/** Round half-up away from zero, so -0.5 -> -1 and 0.5 -> 1 (symmetric for debits/credits). */
export function roundHalfUp(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/** Format cents as an accounting string: 1234567 -> "12,345.67", -50 -> "(0.50)". */
export function formatCents(cents, { currency = '' } = {}) {
  assertInteger(cents)
  const negative = cents < 0
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100).toLocaleString('en-US')
  const frac = String(abs % 100).padStart(2, '0')
  const body = `${currency ? `${currency} ` : ''}${whole}.${frac}`
  return negative ? `(${body})` : body
}

function assertInteger(cents) {
  if (!Number.isInteger(cents)) {
    throw new Error(`Money must be integer minor units, got: ${cents}`)
  }
}
