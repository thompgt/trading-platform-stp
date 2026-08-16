import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { openDatabase, initSchema } from '../src/db/duckdb.js'

const KEY = 'test-api-key-0123456789'

describe('liveness and readiness probes', () => {
  let db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    await initSchema(db)
  })

  it('answers both probes without a key', async () => {
    const app = createApp(db, { apiKey: KEY })
    await request(app).get('/api/health').expect(200)
    const ready = await request(app).get('/api/ready').expect(200)
    // `stores` lists what was actually checked, so a ready response cannot be mistaken for
    // proof that Postgres is up when the order domain simply is not configured.
    expect(ready.body).toEqual({ ok: true, status: 'ready', stores: ['duckdb'] })
  })

  it('checks Postgres too when it is configured, and names it when it fails', async () => {
    const pg = { ping: vi.fn(async () => {}) }
    const ready = await request(createApp(db, { pg })).get('/api/ready').expect(200)
    expect(pg.ping).toHaveBeenCalled()
    expect(ready.body).toEqual({ ok: true, status: 'ready', stores: ['duckdb', 'postgres'] })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const down = { ping: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED 5432'))) }
    const res = await request(createApp(db, { pg: down })).get('/api/ready').expect(503)
    // Which store failed decides which routes are affected, so the probe says.
    expect(res.body).toEqual({ ok: false, status: 'database_unavailable', store: 'postgres' })
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED')
    errorSpy.mockRestore()
  })

  it('reports 503 from readiness while draining, but stays live', async () => {
    const app = createApp(db, { isDraining: () => true })
    await request(app).get('/api/health').expect(200)
    const ready = await request(app).get('/api/ready').expect(503)
    expect(ready.body.status).toBe('draining')
  })

  it('reports 503 when the database cannot answer', async () => {
    const broken = { all: vi.fn(async () => Promise.reject(new Error('handle closed'))) }
    const app = createApp(broken)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await request(app).get('/api/ready').expect(503)
    expect(res.body.status).toBe('database_unavailable')
    expect(res.body.store).toBe('duckdb')
    // The underlying error is logged, not published.
    expect(errorSpy).toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toContain('handle closed')
    errorSpy.mockRestore()
  })

  it('actually queries the database rather than reporting ready blindly', async () => {
    const spy = vi.spyOn(db, 'all')
    const app = createApp(db)
    await request(app).get('/api/ready').expect(200)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
