import express from 'express'
import cors from 'cors'
import { dataRouter } from './routes/data.js'
import { simulationRouter } from './routes/simulation.js'
import { strategyRouter } from './routes/strategy.js'
import { copilotRouter } from './routes/copilot.js'
import { analyticsRouter } from './routes/analytics.js'
import { settlementRouter } from './routes/settlement.js'
import { metricsRouter } from './routes/metrics.js'
import { httpMetricsMiddleware } from './metrics/httpMetrics.js'
import { apiKeyAuth } from './middleware/auth.js'
import { rateLimit } from './middleware/rateLimit.js'

/** Origins allowed to call the API when none are configured — the local Vite dev server. */
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

/** `CORS_ORIGIN` is a comma-separated allowlist; `*` is rejected rather than honored. */
export function parseOrigins(raw) {
  if (!raw) return DEFAULT_ORIGINS
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .filter((o) => o !== '*')
  return origins.length > 0 ? origins : DEFAULT_ORIGINS
}

/**
 * @param {object} db open DuckDB handle
 * @param {object} [options]
 * @param {string|null} [options.apiKey] shared key required on /api; falsy disables the check
 * @param {string[]} [options.corsOrigins] browser origins allowed to call the API
 */
export function createApp(db, { apiKey = null, corsOrigins = DEFAULT_ORIGINS } = {}) {
  const app = express()

  // An explicit allowlist, not `cors()`. The default is a wildcard, which on an API that
  // proxies a paid LLM key and serves ledgers means any page on the internet can spend the
  // operator's money from a visitor's browser.
  app.use(cors({ origin: corsOrigins, credentials: true }))
  app.use(express.json())
  // Before the routes, so every request — including 404s — is counted.
  app.use(httpMetricsMiddleware)

  app.get('/api/health', (req, res) => res.json({ ok: true }))
  app.use(metricsRouter())

  // Everything below this line needs the key. /api/health and /metrics are listed as public
  // inside the middleware so a probe and a Prometheus scrape still work uncredentialed.
  app.use(apiKeyAuth(apiKey))

  app.use('/api/data', dataRouter(db))
  app.use('/api/simulation', simulationRouter(db))
  // The two Groq-backed routers are additionally capped: authentication says who may call
  // them, the limit says how often, and only the second one bounds the bill.
  app.use('/api/strategy', rateLimit({ windowMs: 60_000, max: 20 }), strategyRouter())
  app.use('/api/copilot', rateLimit({ windowMs: 60_000, max: 20 }), copilotRouter())
  app.use('/api/analytics', analyticsRouter(db))
  app.use('/api/settlement', settlementRouter())

  // Last-resort handler: never leak stack traces, always return JSON.
  app.use((err, req, res, next) => {
    console.error(err)
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  })

  return app
}
