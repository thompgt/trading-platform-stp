import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })

/**
 * Fetch daily OHLCV bars for a symbol between two dates (inclusive) from Yahoo Finance.
 * Throws if the symbol is invalid or Yahoo returns no data for the range.
 */
export async function fetchBars(symbol, { period1, period2, interval = '1d' } = {}) {
  if (!symbol || typeof symbol !== 'string') {
    throw new Error('symbol is required')
  }

  const result = await yf.chart(symbol.toUpperCase(), { period1, period2, interval })
  const quotes = (result.quotes || []).filter(
    (q) => q.open != null && q.high != null && q.low != null && q.close != null,
  )

  if (quotes.length === 0) {
    throw new Error(`No data returned for ${symbol} in range ${period1}..${period2}`)
  }

  return quotes.map((q) => ({
    symbol: symbol.toUpperCase(),
    ts: new Date(q.date),
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    volume: q.volume ?? 0,
  }))
}

/** Upsert bars into the `bars` DuckDB table, keyed on (symbol, ts). */
export async function storeBars(db, bars) {
  for (const bar of bars) {
    await db.run(
      `INSERT OR REPLACE INTO bars (symbol, ts, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      bar.symbol,
      bar.ts,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
    )
  }
  return bars.length
}

/** Load stored bars for a symbol/date range, ordered oldest to newest. */
export async function loadBars(db, symbol, { start, end } = {}) {
  const conditions = ['symbol = ?']
  const params = [symbol.toUpperCase()]

  if (start) {
    conditions.push('ts >= ?')
    params.push(new Date(start))
  }
  if (end) {
    conditions.push('ts <= ?')
    params.push(new Date(end))
  }

  const rows = await db.all(
    `SELECT symbol, ts, open, high, low, close, volume FROM bars
     WHERE ${conditions.join(' AND ')}
     ORDER BY ts ASC`,
    ...params,
  )
  // DuckDB returns BIGINT columns as JS BigInt, which JSON.stringify can't serialize.
  return rows.map((r) => ({ ...r, volume: Number(r.volume) }))
}

/** List distinct symbols currently cached, with their stored date range and bar count. */
export async function listCachedSymbols(db) {
  const rows = await db.all(`
    SELECT symbol, MIN(ts) AS start, MAX(ts) AS end, COUNT(*) AS bar_count
    FROM bars
    GROUP BY symbol
    ORDER BY symbol
  `)
  return rows.map((r) => ({ ...r, bar_count: Number(r.bar_count) }))
}
