import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { openDatabase, initSchema } from '../src/db/duckdb.js'
import * as marketData from '../src/data/marketData.js'
import { _resetSignalCacheForTesting } from '../src/routes/analytics.js'

function bars(symbol, count) {
  const start = new Date('2020-01-01T00:00:00.000Z')
  return Array.from({ length: count }, (_, i) => {
    const ts = new Date(start.getTime() + i * 86_400_000)
    const close = 100 + Math.sin(i / 5) * 10 + i * 0.1
    return { symbol, ts, open: close, high: close + 1, low: close - 1, close, volume: 1000 }
  })
}

describe('GET /api/analytics/signals', () => {
  let app
  let db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    await initSchema(db)
    app = createApp(db)
    _resetSignalCacheForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('bounds the lookback instead of loading all cached history', async () => {
    await marketData.storeBars(db, bars('LONG', 1500))
    const spy = vi.spyOn(marketData, 'loadBars')

    const res = await request(app).get('/api/analytics/signals?symbols=LONG').expect(200)
    expect(res.body.lookback).toBe(500)

    // Every load is capped; none asks for the full 1500-bar history.
    for (const call of spy.mock.calls) {
      expect(call[2].limit).toBe(500)
    }
  })

  it('honors an explicit lookback and clamps an absurd one', async () => {
    await marketData.storeBars(db, bars('LONG', 300))

    const small = await request(app)
      .get('/api/analytics/signals?symbols=LONG&lookback=60')
      .expect(200)
    expect(small.body.lookback).toBe(60)

    _resetSignalCacheForTesting()
    const huge = await request(app)
      .get('/api/analytics/signals?symbols=LONG&lookback=999999')
      .expect(200)
    expect(huge.body.lookback).toBe(5000)

    _resetSignalCacheForTesting()
    const junk = await request(app)
      .get('/api/analytics/signals?symbols=LONG&lookback=abc')
      .expect(200)
    expect(junk.body.lookback).toBe(500)
  })

  it('takes the most recent bars, not the oldest', async () => {
    await marketData.storeBars(db, bars('LONG', 600))
    const loaded = await marketData.loadBars(db, 'LONG', { limit: 10 })

    expect(loaded).toHaveLength(10)
    // Oldest-first ordering is preserved, but the window is the tail of the series.
    expect(loaded[0].ts.getTime()).toBeLessThan(loaded.at(-1).ts.getTime())
    const all = await marketData.loadBars(db, 'LONG')
    expect(loaded.at(-1).ts.getTime()).toBe(all.at(-1).ts.getTime())
  })

  it('memoizes per symbol and latest bar rather than recomputing on every poll', async () => {
    await marketData.storeBars(db, bars('CACHE', 300))
    const spy = vi.spyOn(marketData, 'loadBars')

    const first = await request(app).get('/api/analytics/signals?symbols=CACHE').expect(200)
    const second = await request(app).get('/api/analytics/signals?symbols=CACHE').expect(200)

    expect(spy).toHaveBeenCalledTimes(1) // second request served from the memo
    expect(second.body.signals).toEqual(first.body.signals)
  })

  it('invalidates the memo when new bars arrive', async () => {
    await marketData.storeBars(db, bars('CACHE', 300))
    await request(app).get('/api/analytics/signals?symbols=CACHE').expect(200)

    const spy = vi.spyOn(marketData, 'loadBars')
    await request(app).get('/api/analytics/signals?symbols=CACHE').expect(200)
    expect(spy).not.toHaveBeenCalled()

    // One more bar changes both the latest timestamp and the count, so the key moves.
    const extra = bars('CACHE', 301).slice(-1)
    await marketData.storeBars(db, extra)
    await request(app).get('/api/analytics/signals?symbols=CACHE').expect(200)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('separates memo entries by lookback and trend length', async () => {
    await marketData.storeBars(db, bars('CACHE', 300))
    const spy = vi.spyOn(marketData, 'loadBars')

    await request(app).get('/api/analytics/signals?symbols=CACHE&lookback=100').expect(200)
    await request(app).get('/api/analytics/signals?symbols=CACHE&lookback=200').expect(200)
    await request(app)
      .get('/api/analytics/signals?symbols=CACHE&lookback=200&trendLength=20')
      .expect(200)

    expect(spy).toHaveBeenCalledTimes(3)
  })
})
