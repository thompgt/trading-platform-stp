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

// Rows per INSERT statement. A year of daily bars is one statement; a year of 5-minute bars
// is a few hundred rather than tens of thousands. Kept well under any parameter ceiling at
// seven placeholders per row.
const INSERT_CHUNK_SIZE = 500

/**
 * Upsert bars into the `bars` DuckDB table, keyed on (symbol, ts).
 *
 * Batched and wrapped in a transaction. This used to be one awaited round-trip per row, and
 * every one of them queued on the single shared DuckDB connection — ingesting an intraday
 * range meant tens of thousands of sequential statements that blocked every other query in
 * the process, including the ones serving the replay UI.
 *
 * The transaction is also a correctness gain: an ingest that fails halfway now leaves no
 * partial range behind, so a retry starts from a known state.
 */
export async function storeBars(db, bars) {
  if (bars.length === 0) return 0

  await db.run('BEGIN TRANSACTION')
  try {
    for (let i = 0; i < bars.length; i += INSERT_CHUNK_SIZE) {
      const chunk = bars.slice(i, i + INSERT_CHUNK_SIZE)
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')
      const params = chunk.flatMap((bar) => [
        bar.symbol,
        bar.ts,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
      ])
      await db.run(
        `INSERT OR REPLACE INTO bars (symbol, ts, open, high, low, close, volume)
         VALUES ${values}`,
        ...params,
      )
    }
    await db.run('COMMIT')
  } catch (err) {
    // Best-effort: if the rollback itself fails the original error is the useful one.
    await db.run('ROLLBACK').catch(() => {})
    throw err
  }

  return bars.length
}

/**
 * Load stored bars for a symbol/date range, ordered oldest to newest.
 *
 * `limit` takes the *most recent* N bars in the range, not the first N — a bounded lookback
 * is always "the last N bars", and taking them off the front would silently analyse ancient
 * history. The rows still come back oldest-first, because every indicator expects that.
 */
export async function loadBars(db, symbol, { start, end, limit = null } = {}) {
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

  const where = conditions.join(' AND ')
  const sql =
    limit && Number.isInteger(limit) && limit > 0
      ? `SELECT * FROM (
           SELECT symbol, ts, open, high, low, close, volume FROM bars
           WHERE ${where}
           ORDER BY ts DESC
           LIMIT ${limit}
         ) ORDER BY ts ASC`
      : `SELECT symbol, ts, open, high, low, close, volume FROM bars
         WHERE ${where}
         ORDER BY ts ASC`

  const rows = await db.all(sql, ...params)
  // DuckDB returns BIGINT columns as JS BigInt, which JSON.stringify can't serialize.
  return rows.map((r) => ({ ...r, volume: Number(r.volume) }))
}

/**
 * Latest stored timestamp and bar count per symbol — a cheap cache key for anything derived
 * from a symbol's bars, since new data only ever arrives at the end.
 */
export async function latestBarStamp(db, symbol) {
  const [row] = await db.all(
    `SELECT MAX(ts) AS latest, COUNT(*) AS bar_count FROM bars WHERE symbol = ?`,
    symbol.toUpperCase(),
  )
  if (!row?.latest) return null
  return { latest: new Date(row.latest).toISOString(), barCount: Number(row.bar_count) }
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
