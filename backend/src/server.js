import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { createApp, parseOrigins } from './app.js'
import { openDatabase, initSchema } from './db/duckdb.js'
import { enableDefaultMetrics } from './metrics/registry.js'

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

const app = createApp(db, {
  apiKey,
  corsOrigins,
  jsonLimit: process.env.JSON_BODY_LIMIT || '2mb',
  trustProxy: Number.parseInt(process.env.TRUST_PROXY ?? '0', 10) || 0,
})
app.listen(port, () => {
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
