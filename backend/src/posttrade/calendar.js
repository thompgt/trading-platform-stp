/**
 * US equity settlement calendar.
 *
 * Settlement date is trade date plus one *business* day (T+1 since May 2024), and "business"
 * means the exchange calendar, not the ISO week — a trade on the Friday before Memorial Day
 * settles on the Tuesday. Getting this wrong is not a rounding error: it books the cash
 * movement on a day the custodian is shut, which is a fail.
 *
 * Holidays are computed from rules rather than hardcoded per year, so the calendar keeps
 * working past whatever year this was written in. Good Friday is included (the NYSE closes
 * for it even though it is not a federal holiday); bond-market-only closures are not.
 */

const MS_PER_DAY = 86_400_000

/** Trade date + N business days, skipping weekends and exchange holidays. */
export function addBusinessDays(date, days) {
  let cursor = startOfUtcDay(date)
  let remaining = days
  const step = days >= 0 ? 1 : -1
  while (remaining !== 0) {
    cursor = new Date(cursor.getTime() + step * MS_PER_DAY)
    if (isBusinessDay(cursor)) remaining -= step
  }
  return cursor
}

/** True when the exchange is open: a weekday that is not a holiday. */
export function isBusinessDay(date) {
  const day = startOfUtcDay(date)
  const weekday = day.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  return !holidaySet(day.getUTCFullYear()).has(isoDate(day))
}

/** The next business day on or after the given date (a no-op if it is already one). */
export function nextBusinessDay(date) {
  let cursor = startOfUtcDay(date)
  while (!isBusinessDay(cursor)) {
    cursor = new Date(cursor.getTime() + MS_PER_DAY)
  }
  return cursor
}

/** Business days between two dates, counting the later one and not the earlier. */
export function businessDaysBetween(from, to) {
  const start = startOfUtcDay(from)
  const end = startOfUtcDay(to)
  if (end <= start) return 0
  let count = 0
  let cursor = start
  while (cursor < end) {
    cursor = new Date(cursor.getTime() + MS_PER_DAY)
    if (isBusinessDay(cursor)) count++
  }
  return count
}

/** `YYYY-MM-DD` in UTC — the form every settlement date is carried and compared in. */
export function isoDate(date) {
  return startOfUtcDay(date).toISOString().slice(0, 10)
}

/** Midnight UTC on the calendar day of the given date, timestamp or ISO string. */
export function startOfUtcDay(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`)
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

const holidayCache = new Map()

/** Observed NYSE holiday dates for a year, as a set of `YYYY-MM-DD`. */
export function holidaySet(year) {
  const cached = holidayCache.get(year)
  if (cached) return cached

  const dates = [
    observed(utc(year, 0, 1)), // New Year's Day
    nthWeekday(year, 0, 1, 3), // MLK Day — 3rd Monday of January
    nthWeekday(year, 1, 1, 3), // Washington's Birthday — 3rd Monday of February
    goodFriday(year),
    lastWeekday(year, 4, 1), // Memorial Day — last Monday of May
    observed(utc(year, 5, 19)), // Juneteenth
    observed(utc(year, 6, 4)), // Independence Day
    nthWeekday(year, 8, 1, 1), // Labor Day — 1st Monday of September
    nthWeekday(year, 10, 4, 4), // Thanksgiving — 4th Thursday of November
    observed(utc(year, 11, 25)), // Christmas Day
  ]

  const set = new Set(dates.map((d) => d.toISOString().slice(0, 10)))
  holidayCache.set(year, set)
  return set
}

function utc(year, month, day) {
  return new Date(Date.UTC(year, month, day))
}

/** Saturday holidays are observed the preceding Friday, Sunday ones the following Monday. */
function observed(date) {
  const weekday = date.getUTCDay()
  if (weekday === 6) return new Date(date.getTime() - MS_PER_DAY)
  if (weekday === 0) return new Date(date.getTime() + MS_PER_DAY)
  return date
}

function nthWeekday(year, month, weekday, n) {
  const first = utc(year, month, 1)
  const offset = (weekday - first.getUTCDay() + 7) % 7
  return utc(year, month, 1 + offset + (n - 1) * 7)
}

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month + 1, 0))
  const offset = (last.getUTCDay() - weekday + 7) % 7
  return new Date(last.getTime() - offset * MS_PER_DAY)
}

/** Good Friday is the Friday before Easter Sunday (anonymous Gregorian computus). */
function goodFriday(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1
  const day = ((h + l - 7 * m + 114) % 31) + 1
  const easter = utc(year, month, day)
  return new Date(easter.getTime() - 2 * MS_PER_DAY)
}
