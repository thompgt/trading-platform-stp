import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { createApp, parseOrigins } from './app.js'
import { openDatabase, initSchema } from './db/duckdb.js'
import { enableDefaultMetrics } from './metrics/registry.js'
import { createLifecycle } from './lifecycle.js'

const dbPath = process.env.DUCKDB_PATH || './data/market.duckdb'
const port = process.env.PORT || 4000
const corsOrigins = parseOrigins(process.env.CORS_ORIGIN)

// Never start an unauthenticated listener. If no key is configured, mint one and print it —
// the operator can copy it into frontend/.env — rather than leaving the Groq proxy and the
// settlement ledgers open to anything that can reach the port.
const generatedKey = process.env.API_KEY ? null : randomBytes(24).toString('hex')
const apiKey = process.env.API_KEY || generatedKey

// Node process metrics (CPU, memory, event-loop lag, GC) — started here rather than in
// createApp so importing the app under test doesn't install process-wide collectors.
enableDefaultMetrics()

const db = openDatabase(dbPath)
await initSchema(db)

// Installed before the listener exists: a crash during boot should still close the database.
const lifecycle = createLifecycle({
  db,
  drainMs: Number.parseInt(process.env.SHUTDOWN_DRAIN_MS ?? '5000', 10),
  shutdownTimeoutMs: Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '15000', 10),
})
lifecycle.install()

const app = createApp(db, {
  apiKey,
  corsOrigins,
  jsonLimit: process.env.JSON_BODY_LIMIT || '2mb',
  trustProxy: Number.parseInt(process.env.TRUST_PROXY ?? '0', 10) || 0,
  isDraining: lifecycle.isDraining,
})
const server = app.listen(port, () => {
  console.log(`STP backend listening on http://localhost:${port} (DuckDB: ${dbPath})`)
  console.log(`Prometheus metrics at http://localhost:${port}/metrics`)
  console.log(`CORS origins allowed: ${corsOrigins.join(', ')}`)
  if (generatedKey) {
    console.log(
      `\nNo API_KEY set — generated one for this run:\n  API_KEY=${generatedKey}\n` +
        `Put it in backend/.env and as VITE_API_KEY in frontend/.env to keep it across restarts.\n`,
    )
  } else {
    console.log('API key authentication enabled (API_KEY from the environment).')
  }
})

lifecycle.attach(server)

// A port already in use is the everyday startup failure, and Node's default for it is an
// unhandled 'error' event. Name it, then leave through the same shutdown path as anything else.
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Set PORT (and DUCKDB_PATH) to move.`)
  } else {
    console.error('HTTP server error', err)
  }
  lifecycle.shutdown('listen-error', 1)
})
