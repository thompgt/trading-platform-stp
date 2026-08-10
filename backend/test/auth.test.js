import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import { createApp, parseOrigins } from '../src/app.js'
import { openDatabase, initSchema } from '../src/db/duckdb.js'
import { _setGroqClientForTesting } from '../src/agents/groqClient.js'

const KEY = 'test-api-key-0123456789'

function fakeGroqClient(content) {
  return {
    chat: {
      completions: { create: vi.fn(async () => ({ choices: [{ message: { content } }] })) },
    },
  }
}

describe('API key authentication', () => {
  let app
  let db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    await initSchema(db)
    app = createApp(db, { apiKey: KEY })
  })

  afterEach(() => {
    _setGroqClientForTesting(null)
  })

  it('leaves the health probe and the metrics scrape open', async () => {
    await request(app).get('/api/health').expect(200)
    await request(app).get('/metrics').expect(200)
  })

  it('401s an /api request with no key', async () => {
    const res = await request(app).get('/api/data/symbols').expect(401)
    expect(res.body.kind).toBe('unauthorized')
  })

  it('403s an /api request with the wrong key', async () => {
    const res = await request(app)
      .get('/api/data/symbols')
      .set('X-API-Key', 'not-the-key-0123456789')
      .expect(403)
    expect(res.body.kind).toBe('forbidden')
  })

  it('accepts the key as X-API-Key or as a bearer token', async () => {
    await request(app).get('/api/data/symbols').set('X-API-Key', KEY).expect(200)
    await request(app).get('/api/data/symbols').set('Authorization', `Bearer ${KEY}`).expect(200)
  })

  it('closes the settlement ledger and the Groq proxy, not just the read routes', async () => {
    await request(app).post('/api/settlement/run').send({ symbol: 'AAPL', fills: [] }).expect(401)
    await request(app).post('/api/copilot/ask').send({ question: 'hi' }).expect(401)
    await request(app).get('/api/settlement/runs').expect(401)
  })

  it('does not enforce anything when no key is configured', async () => {
    const open = createApp(db)
    await request(open).get('/api/data/symbols').expect(200)
  })
})

describe('CORS origins', () => {
  it('falls back to the local dev server rather than a wildcard', () => {
    expect(parseOrigins(undefined)).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173'])
    expect(parseOrigins('')).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173'])
  })

  it('drops a wildcard entry instead of honoring it', () => {
    expect(parseOrigins('*')).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173'])
    expect(parseOrigins('https://ops.example.com, *')).toEqual(['https://ops.example.com'])
  })

  it('parses a comma-separated allowlist', () => {
    expect(parseOrigins('https://a.example, https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('reflects an allowed origin and refuses an unlisted one', async () => {
    const db = openDatabase(':memory:')
    await initSchema(db)
    const app = createApp(db, { corsOrigins: ['https://ops.example.com'] })

    const allowed = await request(app)
      .get('/api/health')
      .set('Origin', 'https://ops.example.com')
      .expect(200)
    expect(allowed.headers['access-control-allow-origin']).toBe('https://ops.example.com')

    const denied = await request(app).get('/api/health').set('Origin', 'https://evil.example')
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('LLM route rate limiting', () => {
  let app
  let db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    await initSchema(db)
    app = createApp(db)
    _setGroqClientForTesting(
      fakeGroqClient(JSON.stringify({ answer: 'ok', usedFacts: [] })),
    )
  })

  afterEach(() => {
    _setGroqClientForTesting(null)
  })

  it('429s the Groq proxy past the per-minute cap', async () => {
    let limited = null
    for (let i = 0; i < 25; i++) {
      const res = await request(app).post('/api/copilot/ask').send({ question: 'hi' })
      if (res.status === 429) {
        limited = res
        break
      }
    }
    expect(limited).not.toBeNull()
    expect(limited.body.kind).toBe('rate_limited')
    expect(limited.headers['retry-after']).toBeDefined()
  })

  it('does not limit the routes that cost nothing', async () => {
    for (let i = 0; i < 25; i++) {
      await request(app).get('/api/data/symbols').expect(200)
    }
  })
})
