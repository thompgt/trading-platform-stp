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
    expect(ready.body).toEqual({ ok: true, status: 'ready' })
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
