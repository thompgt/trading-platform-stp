import { describe, it, expect } from 'vitest'
import {
  toCents,
  fromCents,
  notionalCents,
  sumCents,
  applyRate,
  roundHalfUp,
  formatCents,
} from '../src/posttrade/money.js'

describe('money', () => {
  it('converts decimals to cents and back', () => {
    expect(toCents(123.45)).toBe(12345)
    expect(fromCents(12345)).toBe(123.45)
  })

  it('rounds half-up away from zero', () => {
    expect(roundHalfUp(0.5)).toBe(1)
    expect(roundHalfUp(-0.5)).toBe(-1)
    expect(roundHalfUp(2.4)).toBe(2)
    expect(toCents(1.005)).toBe(101)
  })

  it('avoids float drift when summing many amounts', () => {
    const cents = [toCents(0.1), toCents(0.2)]
    expect(sumCents(cents)).toBe(30)
    expect(fromCents(sumCents(cents))).toBe(0.3)
  })

  it('computes fill notional from whole shares and a decimal price', () => {
    expect(notionalCents(100, 45.67)).toBe(456700)
    expect(notionalCents(3, 33.333)).toBe(10000)
  })

  it('rejects fractional share quantities', () => {
    expect(() => notionalCents(1.5, 10)).toThrow(/whole number/)
  })

  it('rejects non-integer cent amounts', () => {
    expect(() => sumCents([1.5])).toThrow(/integer minor units/)
    expect(() => fromCents(0.5)).toThrow(/integer minor units/)
  })

  it('rejects non-finite conversions', () => {
    expect(() => toCents(Number.NaN)).toThrow(/non-finite/)
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(/non-finite/)
  })

  it('applies a fee rate and rounds to the cent', () => {
    // SEC fee rate against a $10,000 notional.
    expect(applyRate(1_000_000, 0.0000278)).toBe(28)
    expect(applyRate(100, 0.005)).toBe(1)
  })

  it('formats cents in accounting style with parentheses for credits', () => {
    expect(formatCents(1234567)).toBe('12,345.67')
    expect(formatCents(-50)).toBe('(0.50)')
    expect(formatCents(0)).toBe('0.00')
    expect(formatCents(500, { currency: 'USD' })).toBe('USD 5.00')
  })
})
