import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { openDatabase, initSchema } from '../src/db/duckdb.js'

describe('security headers', () => {
  let app

  beforeEach(async () => {
    const db = openDatabase(':memory:')
    await initSchema(db)
    app = createApp(db)
  })

  it('sets the baseline headers on an API response', async () => {
    const res = await request(app).get('/api/health').expect(200)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('does not advertise the server framework', async () => {
    const res = await request(app).get('/api/health').expect(200)
    expect(res.headers['x-powered-by']).toBeUndefined()
  })

  it('sets HSTS only when the request arrived over TLS', async () => {
    const plain = await request(app).get('/api/health').expect(200)
    expect(plain.headers['strict-transport-security']).toBeUndefined()

    const forwarded = await request(app)
      .get('/api/health')
      .set('x-forwarded-proto', 'https')
      .expect(200)
    expect(forwarded.headers['strict-transport-security']).toContain('max-age=31536000')
  })

  it('still covers a 404, which is served before any route matches', async () => {
    const res = await request(app).get('/api/does-not-exist').expect(404)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('request body limit', () => {
  let db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    await initSchema(db)
  })

  it('rejects a body over the configured limit with 413', async () => {
    const app = createApp(db, { jsonLimit: '1kb' })
    const oversized = { note: 'x'.repeat(4000) }
    await request(app).post('/api/simulation').send(oversized).expect(413)
  })

  it('accepts a body under the limit', async () => {
    const app = createApp(db, { jsonLimit: '1mb' })
    // Reaches the route and fails validation there, not in the parser: the body got through.
    const res = await request(app).post('/api/simulation').send({ note: 'x'.repeat(4000) })
    expect(res.status).not.toBe(413)
  })
})
