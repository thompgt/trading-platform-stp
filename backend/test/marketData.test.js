import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDatabase, initSchema } from '../src/db/duckdb.js'
import { storeBars, loadBars } from '../src/data/marketData.js'

function bars(symbol, count, { startClose = 100 } = {}) {
  const start = new Date('2024-01-01T00:00:00.000Z')
  return Array.from({ length: count }, (_, i) => {
    const ts = new Date(start.getTime() + i * 60_000)
    const close = startClose + i
    return { symbol, ts, open: close, high: close + 1, low: close - 1, close, volume: 1000 + i }
  })
}

describe('storeBars', () => {
  let db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    await initSchema(db)
  })

  it('round-trips every row', async () => {
    const written = await storeBars(db, bars('AAA', 10))
    expect(written).toBe(10)

    const loaded = await loadBars(db, 'AAA')
    expect(loaded).toHaveLength(10)
    expect(loaded[0].close).toBe(100)
    expect(loaded[9].close).toBe(109)
  })

  it('writes in batches rather than one statement per row', async () => {
    const spy = vi.spyOn(db, 'run')
    await storeBars(db, bars('AAA', 10))

    // BEGIN, one INSERT, COMMIT — not ten inserts.
    const inserts = spy.mock.calls.filter(([sql]) => sql.includes('INSERT'))
    expect(inserts).toHaveLength(1)
    expect(spy.mock.calls[0][0]).toBe('BEGIN TRANSACTION')
    expect(spy.mock.calls.at(-1)[0]).toBe('COMMIT')
  })

  it('chunks a batch larger than the chunk size and still stores every row', async () => {
    const spy = vi.spyOn(db, 'run')
    const written = await storeBars(db, bars('BIG', 1200))
    expect(written).toBe(1200)

    const inserts = spy.mock.calls.filter(([sql]) => sql.includes('INSERT'))
    expect(inserts).toHaveLength(3) // 500 + 500 + 200

    const loaded = await loadBars(db, 'BIG')
    expect(loaded).toHaveLength(1200)
    expect(loaded.at(-1).close).toBe(100 + 1199)
  })

  it('stays idempotent on an overlapping re-fetch', async () => {
    await storeBars(db, bars('AAA', 10))
    // Same keys, different values — INSERT OR REPLACE, so 10 rows with the new closes.
    await storeBars(db, bars('AAA', 10, { startClose: 500 }))

    const loaded = await loadBars(db, 'AAA')
    expect(loaded).toHaveLength(10)
    expect(loaded[0].close).toBe(500)
  })

  it('does nothing, and opens no transaction, for an empty batch', async () => {
    const spy = vi.spyOn(db, 'run')
    expect(await storeBars(db, [])).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rolls back rather than leaving a half-written range behind', async () => {
    await storeBars(db, bars('AAA', 5))

    const realRun = db.run.bind(db)
    vi.spyOn(db, 'run').mockImplementation(async (sql, ...params) => {
      if (sql.includes('INSERT')) throw new Error('disk full')
      return realRun(sql, ...params)
    })

    await expect(storeBars(db, bars('AAA', 600, { startClose: 900 }))).rejects.toThrow('disk full')
    vi.restoreAllMocks()

    const loaded = await loadBars(db, 'AAA')
    expect(loaded).toHaveLength(5)
    expect(loaded[0].close).toBe(100)
  })
})
