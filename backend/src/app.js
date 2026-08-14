import express from 'express'
import cors from 'cors'
import { dataRouter } from './routes/data.js'
import { simulationRouter } from './routes/simulation.js'
import { strategyRouter } from './routes/strategy.js'
import { copilotRouter } from './routes/copilot.js'
import { analyticsRouter } from './routes/analytics.js'
import { settlementRouter } from './routes/settlement.js'
import { metricsRouter } from './routes/metrics.js'
import { healthRouter } from './routes/health.js'
import { httpMetricsMiddleware } from './metrics/httpMetrics.js'
import { apiKeyAuth } from './middleware/auth.js'
import { securityHeaders } from './middleware/securityHeaders.js'
import { rateLimit } from './middleware/rateLimit.js'
import { requestLog } from './middleware/requestLog.js'
import { errorHandler } from './middleware/errors.js'
import { logger as defaultLogger } from './lib/logger.js'

/** Origins allowed to call the API when none are configured — the local Vite dev server. */
export const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

/** Largest JSON body accepted. Big enough for a multi-year bar ingest, small enough to bound. */
const DEFAULT_JSON_LIMIT = '2mb'

/**
 * @param {object} db open DuckDB handle
 * @param {object} [options]
 * @param {string|null} [options.apiKey] shared key required on /api; falsy disables the check
 * @param {string[]} [options.corsOrigins] browser origins allowed to call the API
 * @param {string} [options.jsonLimit] largest request body the JSON parser will accept
 * @param {number} [options.trustProxy] reverse-proxy hops in front of this process
 * @param {() => boolean} [options.isDraining] true once graceful shutdown has begun
 * @param {object} [options.logger] structured logger for the access log
 */
export function createApp(
  db,
  {
    apiKey = null,
    corsOrigins = DEFAULT_ORIGINS,
    jsonLimit = DEFAULT_JSON_LIMIT,
    trustProxy = 0,
    isDraining = () => false,
    logger = defaultLogger,
  } = {},
) {
  const app = express()

  // Trust the hop count the operator configures (0 disables it). Without this every request
  // behind a load balancer looks like it came from the balancer, so `req.ip` — which the rate
  // limiter falls back to and the access log records — collapses to a single value.
  app.set('trust proxy', trustProxy)
  app.disable('x-powered-by')

  // First in the chain: everything after this point can log against the request's id.
  app.use(requestLog({ logger }))
  app.use(securityHeaders())
  // An explicit allowlist, not `cors()`. The default is a wildcard, which on an API that
  // proxies a paid LLM key and serves ledgers means any page on the internet can spend the
  // operator's money from a visitor's browser.
  app.use(cors({ origin: corsOrigins, credentials: true }))
  // Bounded on purpose. `express.json()` defaults to 100kb, but the ingest and settlement
  // routes legitimately take larger bodies, so the cap is raised deliberately rather than
  // removed — an unbounded parser lets one request buffer the process out of memory.
  app.use(express.json({ limit: jsonLimit }))
  // Before the routes, so every request — including 404s — is counted.
  app.use(httpMetricsMiddleware)

  app.use(healthRouter(db, { isDraining }))
  app.use(metricsRouter())

  // Everything below this line needs the key. The probes and /metrics are listed as public
  // inside the middleware so an orchestrator and a Prometheus scrape work uncredentialed.
  app.use(apiKeyAuth(apiKey))

  app.use('/api/data', dataRouter(db))
  app.use('/api/simulation', simulationRouter(db))
  // The two Groq-backed routers are additionally capped: authentication says who may call
  // them, the limit says how often, and only the second one bounds the bill.
  app.use('/api/strategy', rateLimit({ windowMs: 60_000, max: 20 }), strategyRouter())
  app.use('/api/copilot', rateLimit({ windowMs: 60_000, max: 20 }), copilotRouter())
  app.use('/api/analytics', analyticsRouter(db))
  app.use('/api/settlement', settlementRouter())

  // Last-resort handler: never leak stack traces or internals, always return JSON. Routes
  // reach it with next(err) rather than writing their own catch-block response.
  app.use(errorHandler())

  return app
}
