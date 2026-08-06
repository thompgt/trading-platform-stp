import { describe, it, expect } from 'vitest'
import {
  addBusinessDays,
  isBusinessDay,
  nextBusinessDay,
  businessDaysBetween,
  isoDate,
  holidaySet,
} from '../src/posttrade/calendar.js'

describe('settlement calendar', () => {
  it('treats ordinary weekdays as business days', () => {
    expect(isBusinessDay('2025-03-05')).toBe(true) // Wednesday
  })

  it('excludes weekends', () => {
    expect(isBusinessDay('2025-03-08')).toBe(false) // Saturday
    expect(isBusinessDay('2025-03-09')).toBe(false) // Sunday
  })

  it('settles T+1 across a weekend', () => {
    // Friday trade date -> Monday settlement.
    expect(isoDate(addBusinessDays('2025-03-07', 1))).toBe('2025-03-10')
  })

  it('skips a holiday that falls on the settlement day', () => {
    // Independence Day 2025 is Friday the 4th, so Thursday trades settle the following Monday.
    expect(isBusinessDay('2025-07-04')).toBe(false)
    expect(isoDate(addBusinessDays('2025-07-03', 1))).toBe('2025-07-07')
  })

  it('recognizes the fixed and floating exchange holidays', () => {
    const days = holidaySet(2025)
    expect(days.has('2025-01-01')).toBe(true) // New Year's Day
    expect(days.has('2025-01-20')).toBe(true) // MLK Day
    expect(days.has('2025-02-17')).toBe(true) // Washington's Birthday
    expect(days.has('2025-04-18')).toBe(true) // Good Friday
    expect(days.has('2025-05-26')).toBe(true) // Memorial Day
    expect(days.has('2025-06-19')).toBe(true) // Juneteenth
    expect(days.has('2025-09-01')).toBe(true) // Labor Day
    expect(days.has('2025-11-27')).toBe(true) // Thanksgiving
    expect(days.has('2025-12-25')).toBe(true) // Christmas
  })

  it('observes a Saturday holiday on the preceding Friday', () => {
    // 2027-12-25 is a Saturday; the exchange closes Friday the 24th.
    expect(holidaySet(2027).has('2027-12-24')).toBe(true)
  })

  it('observes a Sunday holiday on the following Monday', () => {
    // 2028-01-01 is a Saturday, but 2022-01-01 (Sat) -> Dec 31; use Juneteenth 2027 (Sat).
    expect(holidaySet(2022).has('2022-06-20')).toBe(true) // Juneteenth Sunday -> Monday
  })

  it('rolls forward to the next open day', () => {
    expect(isoDate(nextBusinessDay('2025-03-08'))).toBe('2025-03-10')
    expect(isoDate(nextBusinessDay('2025-03-10'))).toBe('2025-03-10')
  })

  it('counts business days between two dates', () => {
    expect(businessDaysBetween('2025-03-07', '2025-03-10')).toBe(1)
    expect(businessDaysBetween('2025-03-03', '2025-03-07')).toBe(4)
    expect(businessDaysBetween('2025-03-07', '2025-03-07')).toBe(0)
  })

  it('walks backwards for negative offsets', () => {
    expect(isoDate(addBusinessDays('2025-03-10', -1))).toBe('2025-03-07')
  })

  it('rejects an unparseable date', () => {
    expect(() => isoDate('not-a-date')).toThrow(/Invalid date/)
  })
})
