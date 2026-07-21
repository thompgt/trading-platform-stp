import duckdb from 'duckdb'

/** Thin promise wrapper around the callback-based `duckdb` driver. */
export function openDatabase(path) {
  const db = new duckdb.Database(path)
  const conn = db.connect()

  function run(sql, ...params) {
    return new Promise((resolve, reject) => {
      conn.run(sql, ...params, (err) => (err ? reject(err) : resolve()))
    })
  }

  function all(sql, ...params) {
    return new Promise((resolve, reject) => {
      conn.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows)))
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
