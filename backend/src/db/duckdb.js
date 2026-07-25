import duckdb from 'duckdb'
import { duckdbQueryDuration } from '../metrics/registry.js'

/**
 * First SQL keyword of a statement, used as the Prometheus `operation` label. The full
 * statement would be unbounded cardinality; the verb is enough to tell a slow read from
 * a slow write.
 */
function operationOf(sql) {
  return sql.trim().split(/\s+/, 1)[0].toUpperCase() || 'UNKNOWN'
}

/** Thin promise wrapper around the callback-based `duckdb` driver. */
export function openDatabase(path) {
  const db = new duckdb.Database(path)
  const conn = db.connect()

  function run(sql, ...params) {
    const end = duckdbQueryDuration.startTimer({ operation: operationOf(sql) })
    return new Promise((resolve, reject) => {
      conn.run(sql, ...params, (err) => {
        end()
        return err ? reject(err) : resolve()
      })
    })
  }

  function all(sql, ...params) {
    const end = duckdbQueryDuration.startTimer({ operation: operationOf(sql) })
    return new Promise((resolve, reject) => {
      conn.all(sql, ...params, (err, rows) => {
        end()
        return err ? reject(err) : resolve(rows)
      })
    })
  }

  function close() {
    return new Promise((resolve, reject) => {
      db.close((err) => (err ? reject(err) : resolve()))
    })
  }

  return { run, all, close }
}

export async function initSchema(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS bars (
      symbol VARCHAR NOT NULL,
      ts TIMESTAMP NOT NULL,
      open DOUBLE,
      high DOUBLE,
      low DOUBLE,
      close DOUBLE,
      volume BIGINT,
      PRIMARY KEY (symbol, ts)
    )
  `)
}
