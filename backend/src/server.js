import 'dotenv/config'
import { createApp } from './app.js'
import { openDatabase, initSchema } from './db/duckdb.js'

const dbPath = process.env.DUCKDB_PATH || './data/market.duckdb'
const port = process.env.PORT || 4000

const db = openDatabase(dbPath)
await initSchema(db)

const app = createApp(db)
app.listen(port, () => {
  console.log(`STP backend listening on http://localhost:${port} (DuckDB: ${dbPath})`)
})
