import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { openDatabase, initSchema } from '../src/db/duckdb.js'
import { storeBars } from '../src/data/marketData.js'
import { register, resetMetrics } from '../src/metrics/registry.js'
import { _resetSettlementRunsForTesting } from '../src/routes/settlement.js'

const FILLS = [
  { ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: 500, price: 50.25 },
  { ts: '2025-03-06T14:30:00.000Z', side: 'SELL', qty: 200, price: 52.5 },
  { ts: '2025-03-07T14:30:00.000Z', side: 'SELL', qty: 300, price: 49.8 },
]

const RUN = {
  symbol: 'AAPL',
  fills: FILLS,
  startingCash: 100000,
  valuationDate: '2025-03-12',
}

/** Rising bars, so an SMA crossover strategy actually trades. */
function risingBars(symbol = 'SETL') {
  const start = new Date('2024-01-01')
  return Array.from({ length: 40 }, (_, i) => {
    const ts = new Date(start)
    ts.setDate(ts.getDate() + i)
    const close = 100 + (i < 20 ? -i * 0.5 : (i - 20) * 2)
    return { symbol, ts, open: close, high: close + 1, low: close - 1, close, volume: 1000 }
  })
}

describe('settlement API', () => {
  let app
  let db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    await initSchema(db)
    app = createApp(db)
    // The registry is module-level, so counters would otherwise carry over between cases
    // and turn an exact assertion into a moving target.
    resetMetrics()
    // The run store is module-level too, and ids are unique per run now, so without this a
    // later case would see every earlier case's runs in GET /runs.
    _resetSettlementRunsForTesting()
  })

  it('runs the procedure and returns the full result', async () => {
    const res = await request(app).post('/api/settlement/run').send(RUN).expect(200)

    // The id is minted server-side: the readable STL-{ticker}-{asOf} stem plus a suffix
    // that keeps two batches on the same symbol and date from overwriting each other.
    expect(res.body.runId).toMatch(/^STL-AAPL-20250312-[0-9a-f]{8}$/)
    expect(res.body.summary).toMatchObject({
      capturedCount: 3,
      settledCount: 3,
      stpRatePct: 100,
      inBalance: true,
      reconciled: true,
    })
    expect(res.body.stages).toHaveLength(5)
    expect(res.body.ledger.cash.lines.length).toBeGreaterThan(0)
  })

  it('rejects a run with no symbol or no fills', async () => {
    await request(app)
      .post('/api/settlement/run')
      .send({ fills: FILLS })
      .expect(400)
      .expect((res) => expect(res.body.error).toMatch(/symbol is required/))

    await request(app)
      .post('/api/settlement/run')
      .send({ symbol: 'AAPL' })
      .expect(400)
      .expect((res) => expect(res.body.error).toMatch(/fills must be an array/))
  })

  it('serves the stored run, its ledger and its breaks', async () => {
    const { body } = await request(app).post('/api/settlement/run').send(RUN).expect(200)

    const run = await request(app).get(`/api/settlement/${body.runId}`).expect(200)
    expect(run.body.runId).toBe(body.runId)

    const ledger = await request(app).get(`/api/settlement/${body.runId}/ledger`).expect(200)
    expect(ledger.body.trialBalance.inBalance).toBe(true)
    expect(ledger.body.cash.closingBalanceCents).toBe(body.summary.closingCashCents)
    expect(ledger.body.entries.length).toBe(body.summary.journalEntryCount)

    const breaks = await request(app).get(`/api/settlement/${body.runId}/breaks`).expect(200)
    expect(breaks.body).toMatchObject({ exceptions: [], fails: [] })
    expect(breaks.body.reconciliation.reconciled).toBe(true)
  })

  it('lists runs', async () => {
    await request(app).post('/api/settlement/run').send(RUN).expect(200)
    const res = await request(app).get('/api/settlement/runs').expect(200)
    expect(res.body.runs).toHaveLength(1)
    expect(res.body.runs[0].runId).toMatch(/^STL-AAPL-20250312-[0-9a-f]{8}$/)
    expect(res.body.runs[0].symbol).toBe('AAPL')
  })

  it('mints a fresh id per run and ignores one supplied by the caller', async () => {
    const first = await request(app).post('/api/settlement/run').send(RUN).expect(200)
    const second = await request(app)
      .post('/api/settlement/run')
      .send({ ...RUN, runId: 'STL-AAPL-20250312' })
      .expect(200)

    // Same symbol, same date, and one of them asked for a specific id — neither may land on
    // the other's stored report.
    expect(second.body.runId).not.toBe(first.body.runId)
    expect(second.body.runId).not.toBe('STL-AAPL-20250312')

    const listed = await request(app).get('/api/settlement/runs').expect(200)
    expect(listed.body.runs).toHaveLength(2)
    await request(app).get(`/api/settlement/${first.body.runId}`).expect(200)
    await request(app).get(`/api/settlement/${second.body.runId}`).expect(200)
  })

  it('404s an unknown run rather than inventing one', async () => {
    for (const path of ['', '/ledger', '/breaks', '/report.pdf']) {
      const res = await request(app).get(`/api/settlement/STL-NOPE-1${path}`).expect(404)
      expect(res.body.error).toMatch(/Unknown settlement run/)
    }
  })

  it('serves the report as a PDF', async () => {
    const { body } = await request(app).post('/api/settlement/run').send(RUN).expect(200)

    const res = await request(app)
      .get(`/api/settlement/${body.runId}/report.pdf`)
      .expect(200)
      .expect('Content-Type', 'application/pdf')

    expect(res.headers['content-disposition']).toContain(`${body.runId}.pdf`)
    expect(Buffer.isBuffer(res.body)).toBe(true)
    expect(res.body.toString('latin1', 0, 8)).toBe('%PDF-1.4')
    expect(Number(res.headers['content-length'])).toBe(res.body.length)
  })

  it('carries exceptions and fails through to the breaks endpoint', async () => {
    const { body } = await request(app)
      .post('/api/settlement/run')
      .send({
        ...RUN,
        confirmDiscrepancies: { 'TRD-AAPL-0002': { qty: 100 } },
        failedTradeIds: ['TRD-AAPL-0003'],
        custodianDiscrepancies: { cashDeltaCents: 250 },
      })
      .expect(200)

    const res = await request(app).get(`/api/settlement/${body.runId}/breaks`).expect(200)
    expect(res.body.exceptions.map((e) => e.stage)).toEqual(
      expect.arrayContaining(['matching', 'settlement', 'reconciliation']),
    )
    expect(res.body.fails[0].tradeId).toBe('TRD-AAPL-0003')
    expect(res.body.reconciliation.reconciled).toBe(false)
  })

  it('settles a paper-trading session through the same pipeline', async () => {
    await storeBars(db, risingBars())
    const session = await request(app)
      .post('/api/simulation/start')
      .send({
        symbol: 'SETL',
        strategy: { kind: 'sma_crossover', params: { fastPeriod: 3, slowPeriod: 8 } },
        startingCash: 100000,
      })
      .expect(200)

    await request(app).post(`/api/simulation/${session.body.sessionId}/step`).send({ n: 40 })

    const res = await request(app)
      .post('/api/settlement/run')
      .send({ sessionId: session.body.sessionId })
      .expect(200)

    expect(res.body.symbol).toBe('SETL')
    expect(res.body.summary.capturedCount).toBeGreaterThan(0)
    expect(res.body.summary.inBalance).toBe(true)
    // Opening cash is taken from the session, not re-supplied by the caller.
    expect(res.body.parameters.openingCashCents).toBe(10_000_000)
  })

  it('404s a settlement run against an unknown session', async () => {
    const res = await request(app)
      .post('/api/settlement/run')
      .send({ sessionId: 'not-a-session' })
      .expect(404)
    expect(res.body.error).toMatch(/Unknown simulation session/)
  })

  it('publishes post-trade metrics', async () => {
    await request(app).post('/api/settlement/run').send(RUN).expect(200)
    const metrics = await register.metrics()

    // The registry stamps a default service label onto every series, so match the value
    // rather than an exact label set.
    expect(metrics).toMatch(/stp_settlement_runs_total\{symbol="AAPL",outcome="clean"[^}]*\} 1/)
    expect(metrics).toMatch(/stp_settlement_trades_total\{symbol="AAPL",status="SETTLED"[^}]*\} 3/)
    expect(metrics).toMatch(/stp_settlement_straight_through_rate_pct\{symbol="AAPL"[^}]*\} 100/)
    expect(metrics).toMatch(/stp_settlement_books_in_balance\{symbol="AAPL"[^}]*\} 1/)
    expect(metrics).toMatch(/stp_settlement_reconciled\{symbol="AAPL"[^}]*\} 1/)
    expect(metrics).toMatch(/stp_settlement_closing_cash_usd\{symbol="AAPL"[^}]*\} 100309\.21/)
  })

  it('counts a run with breaks separately from a clean one', async () => {
    await request(app)
      .post('/api/settlement/run')
      .send({ ...RUN, failedTradeIds: ['TRD-AAPL-0001'] })
      .expect(200)
    const metrics = await register.metrics()

    expect(metrics).toMatch(/stp_settlement_runs_total\{symbol="AAPL",outcome="exceptions"[^}]*\} 1/)
    expect(metrics).toMatch(/stp_settlement_fails_total\{symbol="AAPL",action="BUY_IN"[^}]*\} 1/)
    expect(metrics).not.toMatch(/stp_settlement_runs_total\{symbol="AAPL",outcome="clean"/)
  })

  it('counts rendered reports', async () => {
    const { body } = await request(app).post('/api/settlement/run').send(RUN).expect(200)
    await request(app).get(`/api/settlement/${body.runId}/report.pdf`).expect(200)
    expect(await register.metrics()).toMatch(
      /stp_settlement_reports_rendered_total\{symbol="AAPL"[^}]*\} 1/,
    )
  })
})
