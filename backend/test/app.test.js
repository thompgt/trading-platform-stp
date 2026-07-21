import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { openDatabase, initSchema } from '../src/db/duckdb.js'
import { storeBars } from '../src/data/marketData.js'
import { _setGroqClientForTesting } from '../src/agents/groqClient.js'

function fakeGroqClient(responses) {
  let call = 0
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const content = responses[Math.min(call, responses.length - 1)]
          call++
          return { choices: [{ message: { content } }] }
        }),
      },
    },
  }
}

function sampleBars(symbol = 'TEST') {
  const start = new Date('2024-01-01')
  return Array.from({ length: 20 }, (_, i) => {
    const ts = new Date(start)
    ts.setDate(ts.getDate() + i)
    const close = 100 + i
    return { symbol, ts, open: close, high: close + 1, low: close - 1, close, volume: 1000 }
  })
}

describe('API routes', () => {
  let app
  let db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    await initSchema(db)
    app = createApp(db)
  })

  afterEach(() => {
    _setGroqClientForTesting(null)
  })

  it('GET /api/health reports ok', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  describe('/api/data', () => {
    it('rejects fetch without required fields', async () => {
      const res = await request(app).post('/api/data/fetch').send({})
      expect(res.status).toBe(400)
    })

    it('lists symbols and bars once data has been stored', async () => {
      await storeBars(db, sampleBars('TEST'))

      const symbols = await request(app).get('/api/data/symbols')
      expect(symbols.status).toBe(200)
      expect(symbols.body.symbols).toEqual([expect.objectContaining({ symbol: 'TEST', bar_count: 20 })])

      const bars = await request(app).get('/api/data/bars/TEST')
      expect(bars.status).toBe(200)
      expect(bars.body.bars).toHaveLength(20)
    })
  })

  describe('/api/simulation', () => {
    it('404s starting a session for a symbol with no cached data', async () => {
      const res = await request(app).post('/api/simulation/start').send({ symbol: 'NOPE' })
      expect(res.status).toBe(404)
    })

    it('starts a session, steps forward, rewinds, and jumps', async () => {
      await storeBars(db, sampleBars('TEST'))

      const start = await request(app).post('/api/simulation/start').send({ symbol: 'TEST' })
      expect(start.status).toBe(200)
      expect(start.body.cursor).toBe(0)
      const { sessionId } = start.body

      const stepped = await request(app).post(`/api/simulation/${sessionId}/step`).send({ n: 5 })
      expect(stepped.body.cursor).toBe(5)

      const rewound = await request(app).post(`/api/simulation/${sessionId}/rewind`).send({ n: 2 })
      expect(rewound.body.cursor).toBe(3)

      const jumped = await request(app).post(`/api/simulation/${sessionId}/jump`).send({ date: '2024-01-10' })
      expect(jumped.status).toBe(200)
      expect(jumped.body.currentBar.close).toBeGreaterThan(0)
    })

    it('404s operating on an unknown session id', async () => {
      const res = await request(app).post('/api/simulation/does-not-exist/step').send({})
      expect(res.status).toBe(404)
    })

    it('attaches and runs a strategy through the replay', async () => {
      await storeBars(db, sampleBars('TEST'))
      const start = await request(app)
        .post('/api/simulation/start')
        .send({ symbol: 'TEST', strategy: { kind: 'sma_crossover', params: { fastPeriod: 2, slowPeriod: 5 } } })
      const { sessionId } = start.body

      const stepped = await request(app).post(`/api/simulation/${sessionId}/step`).send({ n: 20 })
      expect(stepped.body.isAtEnd).toBe(true)
      expect(Array.isArray(stepped.body.trades)).toBe(true)
      expect(Array.isArray(stepped.body.equityCurve)).toBe(true)
    })
  })

  describe('/api/strategy/generate', () => {
    it('requires a symbol', async () => {
      const res = await request(app).post('/api/strategy/generate').send({})
      expect(res.status).toBe(400)
    })

    it('returns a validated strategy from the (mocked) LLM', async () => {
      _setGroqClientForTesting(
        fakeGroqClient([
          JSON.stringify({
            name: 'Test Strategy',
            rationale: 'A reasonable rationale for testing purposes.',
            kind: 'sma_crossover',
            params: { fastPeriod: 5, slowPeriod: 20 },
          }),
        ]),
      )
      const res = await request(app).post('/api/strategy/generate').send({ symbol: 'TEST' })
      expect(res.status).toBe(200)
      expect(res.body.strategy.kind).toBe('sma_crossover')
    })

    it('returns 502 with a clear error when the LLM never produces valid output', async () => {
      _setGroqClientForTesting(fakeGroqClient(['not json', 'still not json', 'nope']))
      const res = await request(app).post('/api/strategy/generate').send({ symbol: 'TEST' })
      expect(res.status).toBe(502)
      expect(res.body.kind).toBe('llm_validation_failed')
    })
  })

  describe('/api/copilot/ask', () => {
    it('requires a question', async () => {
      const res = await request(app).post('/api/copilot/ask').send({})
      expect(res.status).toBe(400)
    })

    it('returns a grounded answer from the (mocked) LLM', async () => {
      _setGroqClientForTesting(
        fakeGroqClient([JSON.stringify({ answer: 'Your largest position is TEST.', usedFacts: [] })]),
      )
      const res = await request(app)
        .post('/api/copilot/ask')
        .send({ question: 'What is my largest position?', facts: { positions: [] } })
      expect(res.status).toBe(200)
      expect(res.body.answer).toContain('TEST')
    })
  })
})
