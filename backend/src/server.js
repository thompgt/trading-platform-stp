import 'dotenv/config'
import { createApp } from './app.js'
import { openDatabase, initSchema } from './db/duckdb.js'
import { enableDefaultMetrics } from './metrics/registry.js'

const dbPath = process.env.DUCKDB_PATH || './data/market.duckdb'
const port = process.env.PORT || 4000

// Node process metrics (CPU, memory, event-loop lag, GC) — started here rather than in
// createApp so importing the app under test doesn't install process-wide collectors.
enableDefaultMetrics()

const db = openDatabase(dbPath)
await initSchema(db)

const app = createApp(db)
app.listen(port, () => {
  console.log(`STP backend listening on http://localhost:${port} (DuckDB: ${dbPath})`)
  console.log(`Prometheus metrics at http://localhost:${port}/metrics`)
})
