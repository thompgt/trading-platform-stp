import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createLogger, redact } from '../src/lib/logger.js'
import { resolveRequestId } from '../src/middleware/requestLog.js'
import { createApp } from '../src/app.js'
import { openDatabase, initSchema } from '../src/db/duckdb.js'

/** A logger writing into an array, at debug so nothing is filtered out of the assertions. */
function testLogger(level = 'debug') {
  const written = []
  const log = createLogger({
    level,
    write: (line) => written.push(line),
    now: () => '2026-01-01T00:00:00.000Z',
  })
  return { log, written, records: () => written.map((l) => JSON.parse(l)) }
}

describe('createLogger', () => {
  it('writes one JSON object per line', () => {
    const { log, records } = testLogger()
    log.info('ingest complete', { symbol: 'AAPL', rows: 500 })
    expect(records()).toEqual([
      {
        time: '2026-01-01T00:00:00.000Z',
        level: 'info',
        msg: 'ingest complete',
        symbol: 'AAPL',
        rows: 500,
      },
    ])
  })

  it('drops anything below the configured level, and everything at silent', () => {
    const quiet = testLogger('warn')
    quiet.log.info('ignored')
    quiet.log.warn('kept')
    expect(quiet.records().map((r) => r.msg)).toEqual(['kept'])

    const silent = testLogger('silent')
    silent.log.error('not written')
    expect(silent.written).toEqual([])
  })

  it('serializes an Error, which JSON.stringify otherwise flattens to {}', () => {
    const { log, records } = testLogger()
    log.error('boom', { err: new Error('handle closed') })
    const [record] = records()
    expect(record.err.message).toBe('handle closed')
    expect(record.err.stack).toContain('handle closed')
  })

  it('stamps bound fields on every line from a child', () => {
    const { log, records } = testLogger()
    const child = log.child({ requestId: 'abc' })
    child.info('one')
    child.warn('two')
    expect(records().map((r) => r.requestId)).toEqual(['abc', 'abc'])
  })

  it('redacts credential-shaped fields at any depth', () => {
    expect(redact({ apiKey: 'secret', nested: { authorization: 'Bearer x', ok: 1 } })).toEqual({
      apiKey: '[redacted]',
      nested: { authorization: '[redacted]', ok: 1 },
    })
  })

  it('writes a human line under LOG_FORMAT=pretty', () => {
    const written = []
    const log = createLogger({
      level: 'debug',
      format: 'pretty',
      write: (line) => written.push(line),
      now: () => '2026-01-01T00:00:00.000Z',
    })
    log.info('request', { status: 200 })
    expect(written[0]).toBe('2026-01-01T00:00:00.000Z INFO request status=200')
  })
})

describe('resolveRequestId', () => {
  it('keeps a short, URL-safe id supplied by the caller', () => {
    expect(resolveRequestId('trace-123_abc.4', () => 'generated')).toBe('trace-123_abc.4')
  })

  it('replaces anything absent, oversized, or unsafe', () => {
    expect(resolveRequestId(undefined, () => 'generated')).toBe('generated')
    expect(resolveRequestId('   ', () => 'generated')).toBe('generated')
    expect(resolveRequestId('x'.repeat(65), () => 'generated')).toBe('generated')
    // A newline would let a caller forge extra log lines.
    expect(resolveRequestId('abc\ninjected line', () => 'generated')).toBe('generated')
  })
})

describe('request logging', () => {
  let db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    await initSchema(db)
  })

  it('echoes a request id back and logs the request against it', async () => {
    const { log, records } = testLogger()
    const app = createApp(db, { logger: log })

    const res = await request(app).get('/api/data/symbols').expect(200)

    const id = res.headers['x-request-id']
    expect(id).toBeTruthy()
    const line = records().find((r) => r.msg === 'request')
    expect(line).toMatchObject({ requestId: id, method: 'GET', status: 200 })
    expect(line.route).toBe('/api/data/symbols')
    expect(typeof line.durationMs).toBe('number')
  })

  it('reuses the caller-supplied correlation id', async () => {
    const { log, records } = testLogger()
    const app = createApp(db, { logger: log })

    const res = await request(app)
      .get('/api/data/symbols')
      .set('x-request-id', 'upstream-42')
      .expect(200)

    expect(res.headers['x-request-id']).toBe('upstream-42')
    expect(records().some((r) => r.requestId === 'upstream-42')).toBe(true)
  })

  it('logs probes at debug so a scrape loop does not bury real traffic', async () => {
    const { log, records } = testLogger()
    const app = createApp(db, { logger: log })

    await request(app).get('/api/health').expect(200)
    expect(records().find((r) => r.path === '/api/health').level).toBe('debug')

    await request(app).get('/api/data/symbols').expect(200)
    expect(records().find((r) => r.path === '/api/data/symbols').level).toBe('info')
  })

  it('logs a 5xx at error level', async () => {
    const failing = { all: async () => Promise.reject(new Error('nope')), run: async () => {} }
    const { log, records } = testLogger()
    const app = createApp(failing, { logger: log })

    await request(app).get('/api/data/symbols').expect(500)
    expect(records().some((r) => r.level === 'error' && r.status === 500)).toBe(true)
  })
})
