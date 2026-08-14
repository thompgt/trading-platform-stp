import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { httpError, badRequest } from '../src/middleware/errors.js'

/**
 * The contract these tests pin down: a client learns what it did wrong, and nothing about
 * how the server is built. A 4xx we raised on purpose keeps its wording; an error that
 * escaped from DuckDB, the filesystem or a library is logged and reported as a bare 500.
 */

// The handler logs every failure through the injected structured logger; these tests read
// the captured lines instead of letting them reach stdout.
let lines

function capturingLogger(bound = {}) {
  if (!bound.requestId) lines = []
  const record = (level) => (msg, fields) => lines.push({ level, msg, ...bound, ...fields })
  return {
    level: 'debug',
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: (more) => capturingLogger({ ...bound, ...more }),
  }
}

/** The app under test, with its log captured. */
function appWith(db) {
  return createApp(db, { logger: capturingLogger() })
}

/** A db whose every query fails the way DuckDB actually fails: with our schema in the text. */
function failingDb(message) {
  const fail = async () => {
    throw new Error(message)
  }
  return { all: fail, run: fail, exec: fail, close: () => {} }
}

const DUCKDB_LEAK =
  'Catalog Error: Table with name bars does not exist! Did you mean "C:\\Users\\ops\\stp\\market.duckdb"?'

describe('error responses', () => {
  it('does not echo an unexpected internal error back to the caller', async () => {
    const app = appWith(failingDb(DUCKDB_LEAK))
    const res = await request(app).get('/api/data/symbols')

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal server error')
    expect(Object.keys(res.body).sort()).toEqual(['error', 'requestId'])
    expect(JSON.stringify(res.body)).not.toContain('Catalog Error')
    expect(JSON.stringify(res.body)).not.toContain('market.duckdb')

    // Logged, not published — the operator still gets the real thing, tied to the id the
    // caller was handed.
    const logged = lines.find((l) => l.level === 'error')
    expect(logged.err.message).toContain('Catalog Error')
    expect(logged.requestId).toBe(res.body.requestId)
  })

  it('reports an upstream market-data failure without quoting the provider', async () => {
    const app = appWith(failingDb('unused'))
    const res = await request(app)
      .post('/api/data/fetch')
      .send({ symbol: 'TEST', period1: '2024-01-01', period2: '2024-02-01' })

    // Either the provider or the store fails here; whichever it is, no internals escape.
    expect([500, 502]).toContain(res.status)
    expect(res.body.error).not.toMatch(/Catalog Error|duckdb|https?:\/\//i)
  })

  it('keeps the wording of a 4xx we raised ourselves', async () => {
    const app = appWith(failingDb('unused'))
    const res = await request(app).post('/api/simulation/does-not-exist/step').send({})

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Unknown simulation session/)
  })
})

describe('httpError', () => {
  it('marks the error exposable with the status it names', () => {
    const err = httpError(502, 'Upstream is unwell', { kind: 'upstream' })
    expect(err.status).toBe(502)
    expect(err.expose).toBe(true)
    expect(err.kind).toBe('upstream')
  })

  it('badRequest is a 400 that carries its cause for the log', () => {
    const cause = new Error('the real reason')
    const err = badRequest('fills must be an array', { cause })
    expect(err.status).toBe(400)
    expect(err.message).toBe('fills must be an array')
    expect(err.cause).toBe(cause)
  })
})
