import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { openDatabase, initSchema } from '../src/db/duckdb.js'
import { storeBars } from '../src/data/marketData.js'
import { _setGroqClientForTesting } from '../src/agents/groqClient.js'
import { register, resetMetrics, enableDefaultMetrics } from '../src/metrics/registry.js'
import { routeLabel } from '../src/metrics/httpMetrics.js'

function sampleBars(symbol = 'TEST') {
  const start = new Date('2024-01-01')
  return Array.from({ length: 20 }, (_, i) => {
    const ts = new Date(start)
    ts.setDate(ts.getDate() + i)
    const close = 100 + i
    return { symbol, ts, open: close, high: close + 1, low: close - 1, close, volume: 1000 }
  })
}

/**
 * An oscillating series, unlike the monotonic `sampleBars`. A price that only ever rises
 * never produces an SMA *crossover*, so it yields zero trades — useless for asserting on
 * trading metrics. This one swings enough for the crossover to fire repeatedly and to
 * leave a position open at the end.
 */
function oscillatingBars(symbol = 'TEST', length = 60) {
  const start = new Date('2024-01-01')
  return Array.from({ length }, (_, i) => {
    const ts = new Date(start)
    ts.setDate(ts.getDate() + i)
    const close = 100 + 15 * Math.sin(i / 3)
    return { symbol, ts, open: close, high: close + 1, low: close - 1, close, volume: 1000 }
  })
}

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

/**
 * Summed value of a series in the registry snapshot. Histogram suffixes (`_count`,
 * `_sum`) are looked up through their parent metric, since prom-client reports a
 * histogram under its base name with the suffix carried on each value's `metricName`.
 */
async function metricValue(name, labelFilter = {}) {
  const snapshot = await register.getMetricsAsJSON()
  const direct = snapshot.find((m) => m.name === name)
  const values = direct
    ? direct.values
    : (snapshot.find((m) => name.startsWith(`${m.name}_`))?.values ?? []).filter(
        (v) => v.metricName === name,
      )
  return values
    .filter((v) => Object.entries(labelFilter).every(([k, val]) => v.labels?.[k] === val))
    .reduce((sum, v) => sum + v.value, 0)
}

describe('routeLabel', () => {
  it('uses the matched route pattern so session ids do not explode label cardinality', () => {
    expect(routeLabel({ baseUrl: '/api/simulation', route: { path: '/:id/step' }, path: '/abc/step' })).toBe(
      '/api/simulation/:id/step',
    )
  })

  it('collapses a bare mount point to its base path', () => {
    expect(routeLabel({ baseUrl: '/api/data', route: { path: '/' }, path: '/' })).toBe('/api/data')
  })

  it('labels unmatched requests as unmatched rather than as their raw url', () => {
    expect(routeLabel({ path: '/nope/12345' })).toBe('unmatched')
  })

  it('labels the scrape endpoint, which is mounted without a router', () => {
    expect(routeLabel({ path: '/metrics' })).toBe('/metrics')
  })
})

describe('metrics endpoints', () => {
  let app
  let db

  beforeEach(async () => {
    resetMetrics()
    db = openDatabase(':memory:')
    await initSchema(db)
    app = createApp(db)
  })

  afterEach(() => {
    _setGroqClientForTesting(null)
  })

  it('GET /metrics returns Prometheus text exposition format', async () => {
    await request(app).get('/api/health')
    const res = await request(app).get('/metrics')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.text).toContain('# HELP stp_http_requests_total')
    expect(res.text).toContain('# TYPE stp_http_requests_total counter')
    expect(res.text).toContain('stp_http_requests_total{')
  })

  it('counts requests by matched route, not by raw url', async () => {
    await storeBars(db, sampleBars('TEST'))
    const start = await request(app).post('/api/simulation/start').send({ symbol: 'TEST' })
    const { sessionId } = start.body
    await request(app).post(`/api/simulation/${sessionId}/step`).send({ n: 3 })
    await request(app).post(`/api/simulation/${sessionId}/step`).send({ n: 3 })

    const res = await request(app).get('/metrics')
    expect(res.text).toContain('route="/api/simulation/:id/step"')
    expect(res.text).not.toContain(sessionId)
    expect(await metricValue('stp_http_requests_total', { route: '/api/simulation/:id/step' })).toBe(2)
  })

  it('records request latency and status codes', async () => {
    await request(app).get('/api/health')
    await request(app).get('/api/simulation/nope/state')

    expect(await metricValue('stp_http_requests_total', { status: '200' })).toBeGreaterThan(0)
    expect(await metricValue('stp_http_requests_total', { status: '404' })).toBe(1)
    expect(await metricValue('stp_http_request_duration_seconds_count')).toBeGreaterThan(0)
  })

  it('leaves no requests in flight once responses have finished', async () => {
    await request(app).get('/api/health')
    expect(await metricValue('stp_http_requests_in_flight')).toBe(0)
  })

  it('tracks simulation sessions and control actions', async () => {
    await storeBars(db, sampleBars('TEST'))
    const start = await request(app).post('/api/simulation/start').send({ symbol: 'TEST' })
    const { sessionId } = start.body
    await request(app).post(`/api/simulation/${sessionId}/step`).send({ n: 5 })
    await request(app).post(`/api/simulation/${sessionId}/rewind`).send({ n: 2 })
    await request(app).post(`/api/simulation/${sessionId}/reset`).send({})

    expect(await metricValue('stp_simulation_sessions_started_total', { symbol: 'TEST' })).toBe(1)
    expect(await metricValue('stp_simulation_actions_total', { action: 'step' })).toBe(1)
    expect(await metricValue('stp_simulation_actions_total', { action: 'rewind' })).toBe(1)
    expect(await metricValue('stp_simulation_actions_total', { action: 'reset' })).toBe(1)
    expect(await metricValue('stp_simulation_sessions_active')).toBeGreaterThan(0)
  })

  it('publishes live P&L gauges as the session is stepped, without anyone calling /performance', async () => {
    await storeBars(db, oscillatingBars('TEST'))
    const start = await request(app)
      .post('/api/simulation/start')
      .send({ symbol: 'TEST', strategy: { kind: 'sma_crossover', params: { fastPeriod: 2, slowPeriod: 5 } } })
    await request(app).post(`/api/simulation/${start.body.sessionId}/step`).send({ n: 60 })

    expect(await metricValue('stp_session_equity_usd', { symbol: 'TEST' })).toBeGreaterThan(0)
    expect(await metricValue('stp_session_pnl_usd', { symbol: 'TEST' })).not.toBe(0)
    expect(await metricValue('stp_session_exposure_pct', { symbol: 'TEST' })).toBeGreaterThan(0)
    expect(await metricValue('stp_session_trades', { symbol: 'TEST' })).toBeGreaterThan(0)
  })

  it('counts risk alerts by severity', async () => {
    await storeBars(db, oscillatingBars('TEST'))
    const start = await request(app)
      .post('/api/simulation/start')
      .send({ symbol: 'TEST', strategy: { kind: 'sma_crossover', params: { fastPeriod: 2, slowPeriod: 5 } } })
    await request(app).post(`/api/simulation/${start.body.sessionId}/step`).send({ n: 60 })
    await request(app).get(`/api/simulation/${start.body.sessionId}/risk`)

    // The strategy ends holding a fully-concentrated position, which trips the hard limit.
    expect(await metricValue('stp_risk_alerts_total', { severity: 'high' })).toBeGreaterThan(0)
    expect(await metricValue('stp_risk_alerts_total', { agent: 'Pre-Trade Risk' })).toBeGreaterThan(0)
  })

  it('records LLM calls with a per-agent label and a success outcome', async () => {
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
    await request(app).post('/api/strategy/generate').send({ symbol: 'TEST' })

    expect(await metricValue('stp_llm_requests_total', { agent: 'strategy_generation', outcome: 'success' })).toBe(1)
    expect(await metricValue('stp_llm_request_duration_seconds_count', { agent: 'strategy_generation' })).toBe(1)
  })

  it('distinguishes schema-validation failures from a healthy call, and counts the retries', async () => {
    _setGroqClientForTesting(fakeGroqClient(['not json', 'still not json', 'nope']))
    await request(app).post('/api/strategy/generate').send({ symbol: 'TEST' })

    expect(
      await metricValue('stp_llm_requests_total', { agent: 'strategy_generation', outcome: 'validation_failed' }),
    ).toBe(1)
    expect(await metricValue('stp_llm_requests_total', { outcome: 'success' })).toBe(0)
    expect(await metricValue('stp_llm_validation_retries_total', { agent: 'strategy_generation' })).toBe(3)
  })

  it('records a transport failure as an error rather than a validation failure', async () => {
    _setGroqClientForTesting({
      chat: { completions: { create: vi.fn(async () => { throw new Error('groq is down') }) } },
    })
    await request(app).post('/api/strategy/generate').send({ symbol: 'TEST' })

    expect(await metricValue('stp_llm_requests_total', { agent: 'strategy_generation', outcome: 'error' })).toBe(1)
    expect(await metricValue('stp_llm_requests_total', { outcome: 'validation_failed' })).toBe(0)
  })

  it('times DuckDB queries by operation', async () => {
    await storeBars(db, sampleBars('TEST'))
    await request(app).get('/api/data/bars/TEST')

    expect(await metricValue('stp_duckdb_query_duration_seconds_count', { operation: 'SELECT' })).toBeGreaterThan(0)
    expect(await metricValue('stp_duckdb_query_duration_seconds_count', { operation: 'INSERT' })).toBeGreaterThan(0)
  })

  describe('GET /api/metrics/summary', () => {
    it('rolls the registry up into JSON the dashboard can render', async () => {
      await storeBars(db, sampleBars('TEST'))
      const start = await request(app).post('/api/simulation/start').send({ symbol: 'TEST' })
      await request(app).post(`/api/simulation/${start.body.sessionId}/step`).send({ n: 5 })

      const res = await request(app).get('/api/metrics/summary')
      expect(res.status).toBe(200)
      expect(res.body.http.totalRequests).toBeGreaterThan(0)
      expect(res.body.http.avgLatencyMs).toBeGreaterThanOrEqual(0)
      expect(res.body.http.byRoute.length).toBeGreaterThan(0)
      expect(res.body.simulation.sessionsStarted).toBe(1)
      expect(res.body.simulation.actions.step).toBe(1)
      expect(res.body.process.uptimeSeconds).toBeGreaterThanOrEqual(0)
      expect(res.body.process.nodeVersion).toBe(process.version)
      expect(res.body.sessions).toEqual([expect.objectContaining({ symbol: 'TEST' })])
    })

    it('reports an error rate over both 4xx and 5xx responses', async () => {
      await request(app).get('/api/health')
      await request(app).get('/api/simulation/nope/state')

      const res = await request(app).get('/api/metrics/summary')
      expect(res.body.http.errorRequests).toBe(1)
      expect(res.body.http.errorRatePct).toBeGreaterThan(0)
      expect(res.body.http.errorRatePct).toBeLessThan(100)
    })

    it('is safe to call on a completely cold registry', async () => {
      resetMetrics()
      const res = await request(app).get('/api/metrics/summary')
      expect(res.status).toBe(200)
      expect(res.body.http.errorRatePct).toBe(0)
      expect(res.body.http.avgLatencyMs).toBe(0)
      expect(res.body.sessions).toEqual([])
    })

    it('includes Node process metrics once default collection is enabled', async () => {
      enableDefaultMetrics()
      const res = await request(app).get('/api/metrics/summary')
      expect(res.body.process.residentMemoryMb).toBeGreaterThan(0)
      expect(res.body.process.heapUsedMb).toBeGreaterThan(0)
    })
  })
})
