import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { openDatabase, initSchema } from '../src/db/duckdb.js'
import { storeBars } from '../src/data/marketData.js'

function sampleBars(symbol = 'VAL') {
  const start = new Date('2024-01-01')
  return Array.from({ length: 20 }, (_, i) => {
    const ts = new Date(start)
    ts.setDate(ts.getDate() + i)
    const close = 100 + i
    return { symbol, ts, open: close, high: close + 1, low: close - 1, close, volume: 1000 }
  })
}

describe('request body validation', () => {
  let app
  let db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    await initSchema(db)
    app = createApp(db)
    await storeBars(db, sampleBars('VAL'))
  })

  async function startSession() {
    const res = await request(app).post('/api/simulation/start').send({ symbol: 'VAL' })
    return res.body.sessionId
  }

  it('rejects a fractional step count instead of truncating it into bars.slice', async () => {
    const id = await startSession()

    const res = await request(app).post(`/api/simulation/${id}/step`).send({ n: 2.7 })
    expect(res.status).toBe(400)
    expect(res.body.kind).toBe('invalid_request')
    expect(res.body.error).toMatch(/whole number of bars/)

    // The rejected action must not have moved the cursor.
    const state = await request(app).get(`/api/simulation/${id}/state`)
    expect(state.body.cursor).toBe(0)
  })

  it('rejects a non-numeric or absurd step count', async () => {
    const id = await startSession()
    await request(app).post(`/api/simulation/${id}/step`).send({ n: 'five' }).expect(400)
    await request(app).post(`/api/simulation/${id}/rewind`).send({ n: 1.5 }).expect(400)
    await request(app).post(`/api/simulation/${id}/step`).send({ n: 10 ** 9 }).expect(400)
  })

  it('still accepts a whole step count and a missing one', async () => {
    const id = await startSession()
    await request(app).post(`/api/simulation/${id}/step`).send({ n: 3 }).expect(200)
    const res = await request(app).post(`/api/simulation/${id}/step`).send({}).expect(200)
    expect(res.body.cursor).toBe(4)
  })

  it('rejects a malformed strategy on start and on update', async () => {
    const bad = await request(app)
      .post('/api/simulation/start')
      .send({ symbol: 'VAL', strategy: { kind: 'martingale' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/strategy.kind must be one of/)

    const id = await startSession()
    const put = await request(app)
      .put(`/api/simulation/${id}/strategy`)
      .send({ strategy: { kind: 'nope' } })
    expect(put.status).toBe(400)
  })

  it('rejects a non-positive starting cash', async () => {
    const res = await request(app)
      .post('/api/simulation/start')
      .send({ symbol: 'VAL', startingCash: -5 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/startingCash must be positive/)
  })

  it('rejects fills that are not actually executions', async () => {
    const cases = [
      { fills: ['not-a-fill'] },
      { fills: [{ ts: '2025-03-05T14:30:00.000Z', side: 'HOLD', qty: 1, price: 1 }] },
      { fills: [{ ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: -1, price: 1 }] },
      { fills: [{ ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: 1, price: -1 }] },
      { fills: 'everything' },
    ]

    for (const body of cases) {
      const res = await request(app)
        .post('/api/settlement/run')
        .send({ symbol: 'AAPL', ...body })
      expect(res.status).toBe(400)
    }
  })

  it('accepts a well-formed settlement run', async () => {
    await request(app)
      .post('/api/settlement/run')
      .send({
        symbol: 'AAPL',
        startingCash: 100000,
        fills: [{ ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: 100, price: 50 }],
      })
      .expect(200)
  })

  it('requires the fields the data fetch actually needs, and names the missing one', async () => {
    const res = await request(app).post('/api/data/fetch').send({ symbol: 'AAPL' })
    expect(res.status).toBe(400)
    expect(res.body.kind).toBe('invalid_request')
    expect(res.body.details.join(' ')).toMatch(/period1/)
  })

  it('rejects an empty question and an empty symbol on the gen-AI routes', async () => {
    const q = await request(app).post('/api/copilot/ask').send({ question: '   ' })
    expect(q.status).toBe(400)
    expect(q.body.error).toMatch(/question is required/)

    const s = await request(app).post('/api/strategy/generate').send({ symbol: '' })
    expect(s.status).toBe(400)
    expect(s.body.error).toMatch(/symbol is required/)
  })

  it('reports every problem, not just the first', async () => {
    const res = await request(app).post('/api/data/fetch').send({})
    expect(res.status).toBe(400)
    expect(res.body.details.length).toBeGreaterThan(1)
  })
})
