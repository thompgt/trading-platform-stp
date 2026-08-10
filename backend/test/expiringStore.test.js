import { describe, it, expect, vi, afterEach } from 'vitest'
import request from 'supertest'
import { ExpiringStore } from '../src/lib/expiringStore.js'
import { createApp } from '../src/app.js'
import { openDatabase, initSchema } from '../src/db/duckdb.js'
import { storeBars } from '../src/data/marketData.js'

function sampleBars(symbol = 'TEST') {
  const start = new Date('2024-01-01')
  return Array.from({ length: 20 }, (_, i) => {
    const ts = new Date(start)
    ts.setDate(ts.getDate() + i)
    const close = 100 + i
    return { symbol, ts, open: close, high: close + 1, low: close - 1, close, volume: 1000 }
  })
}

describe('ExpiringStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores and reads back', () => {
    const store = new ExpiringStore()
    store.set('a', 1)
    expect(store.get('a')).toBe(1)
    expect(store.size).toBe(1)
    expect(store.get('missing')).toBeUndefined()
  })

  it('drops the least-recently-used entry past the cap', () => {
    const evicted = []
    const store = new ExpiringStore({ maxEntries: 3, onEvict: (k) => evicted.push(k) })
    store.set('a', 1)
    store.set('b', 2)
    store.set('c', 3)

    // Reading 'a' makes 'b' the least recently used, so 'b' is what goes.
    store.get('a')
    store.set('d', 4)

    expect(evicted).toEqual(['b'])
    expect(store.size).toBe(3)
    expect(store.get('a')).toBe(1)
    expect(store.get('b')).toBeUndefined()
  })

  it('expires entries after the TTL rather than holding them forever', () => {
    vi.useFakeTimers()
    const store = new ExpiringStore({ ttlMs: 1000 })
    store.set('a', 1)

    vi.advanceTimersByTime(999)
    expect(store.get('a')).toBe(1) // and that read renews it

    vi.advanceTimersByTime(999)
    expect(store.get('a')).toBe(1)

    vi.advanceTimersByTime(1001)
    expect(store.get('a')).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('reports eviction through onEvict for both TTL and delete', () => {
    vi.useFakeTimers()
    const evicted = []
    const store = new ExpiringStore({ ttlMs: 1000, onEvict: (k) => evicted.push(k) })
    store.set('a', 1)
    store.set('b', 2)

    expect(store.delete('a')).toBe(true)
    expect(store.delete('a')).toBe(false)
    vi.advanceTimersByTime(1001)
    expect(store.size).toBe(0)
    expect(evicted).toEqual(['a', 'b'])
  })

  it('iterates live entries oldest first', () => {
    const store = new ExpiringStore()
    store.set('a', 1)
    store.set('b', 2)
    expect([...store]).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })
})

describe('session and run lifecycle over HTTP', () => {
  it('DELETEs a replay session and 404s it afterwards', async () => {
    const db = openDatabase(':memory:')
    await initSchema(db)
    const app = createApp(db)
    await storeBars(db, sampleBars('TEST'))

    const { body } = await request(app).post('/api/simulation/start').send({ symbol: 'TEST' })
    const { sessionId } = body

    await request(app).get(`/api/simulation/${sessionId}/state`).expect(200)

    const deleted = await request(app).delete(`/api/simulation/${sessionId}`).expect(200)
    expect(deleted.body).toMatchObject({ sessionId, deleted: true })

    await request(app).get(`/api/simulation/${sessionId}/state`).expect(404)
    await request(app).delete(`/api/simulation/${sessionId}`).expect(404)
  })

  it('DELETEs a settlement run and 404s it afterwards', async () => {
    const db = openDatabase(':memory:')
    await initSchema(db)
    const app = createApp(db)

    const { body } = await request(app)
      .post('/api/settlement/run')
      .send({
        symbol: 'DELME',
        startingCash: 100000,
        valuationDate: '2025-03-12',
        fills: [{ ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: 10, price: 50 }],
      })
      .expect(200)

    await request(app).get(`/api/settlement/${body.runId}`).expect(200)
    await request(app).delete(`/api/settlement/${body.runId}`).expect(200)
    await request(app).get(`/api/settlement/${body.runId}`).expect(404)
    await request(app).delete(`/api/settlement/${body.runId}`).expect(404)
  })
})
