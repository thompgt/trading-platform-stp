/**
 * The transactional store.
 *
 * DuckDB stays where it belongs — bars, indicators, replay, anything that scans a column.
 * It is the wrong engine for orders: one exclusive file lock, one connection, an analytical
 * writer. An order book needs concurrent writers, row-level locking and durable transactions
 * that either commit whole or not at all, which is what Postgres is for.
 *
 * So the platform has two stores on purpose, each doing what it is good at. The rule that
 * keeps that honest: **anything that can change a position, a balance or an order's state
 * lives here**, and DuckDB never holds anything that cannot be recomputed from bars.
 *
 * The pool is instrumented the same way DuckDB is, because a saturated pool and a slow query
 * look identical from the outside and have opposite fixes.
 */
import pg from 'pg'
import { pgQueryDuration, pgPoolConnections, pgPoolWaiting } from '../metrics/registry.js'

const { Pool, types } = pg

// node-postgres hands back `numeric` as a string to avoid silent float precision loss, and
// that is the right default — the money in this platform is integer cents and must never
// become a float. Registering a parser that returns Number here would undo exactly the care
// `posttrade/money.js` takes, so we leave it as a string and parse deliberately at the edge.
// BIGINT (20) is the same story: parsed to a string, converted where the caller knows the range.
types.setTypeParser(types.builtins.INT8, (value) => (value === null ? null : String(value)))

/** First SQL keyword, used as the metric's `operation` label — same reasoning as DuckDB's. */
function operationOf(sql) {
  return sql.trim().split(/\s+/, 1)[0].toUpperCase() || 'UNKNOWN'
}

/**
 * @param {object} options
 * @param {string} options.connectionString `postgres://user:pass@host:port/db`
 * @param {number} [options.max] pool size
 * @param {object} [options.logger] structured logger
 */
export function createPostgres({ connectionString, max = 10, logger = console } = {}) {
  const pool = new Pool({
    connectionString,
    max,
    // Fail a checkout rather than queueing forever: a request that cannot get a connection
    // should return an error the caller can see, not hang until their client times out.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Postgres will kill a query that runs away; without this a single bad query holds a
    // pool slot indefinitely and takes the whole API down with it.
    statement_timeout: 15_000,
    query_timeout: 15_000,
  })

  // An idle client erroring (the server restarted, the network dropped) emits on the pool.
  // Unhandled, that is an uncaughtException and the process dies for a recoverable event.
  pool.on('error', (err) => {
    logger.error?.('idle postgres client errored', { err })
  })

  function observePool() {
    pgPoolConnections.set({ state: 'total' }, pool.totalCount)
    pgPoolConnections.set({ state: 'idle' }, pool.idleCount)
    pgPoolWaiting.set(pool.waitingCount)
  }

  /** Run a query, returning rows. Parameters are always bound, never interpolated. */
  async function query(sql, params = []) {
    const end = pgQueryDuration.startTimer({ operation: operationOf(sql) })
    try {
      const result = await pool.query(sql, params)
      return result.rows
    } finally {
      end()
      observePool()
    }
  }

  /** The single row a query must return, or null. Throws if it returns more than one. */
  async function one(sql, params = []) {
    const rows = await query(sql, params)
    if (rows.length > 1) throw new Error(`Expected at most one row, got ${rows.length}`)
    return rows[0] ?? null
  }

  /**
   * Run `fn` inside a transaction on a single dedicated client.
   *
   * Every write path in the order domain goes through this. Taking a client per statement
   * from the pool would put the statements of one logical change on different connections,
   * which is not a transaction at all — it just looks like one.
   */
  async function transaction(fn) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn({
        query: async (sql, params = []) => {
          const end = pgQueryDuration.startTimer({ operation: operationOf(sql) })
          try {
            return (await client.query(sql, params)).rows
          } finally {
            end()
          }
        },
        one: async (sql, params = []) => {
          const rows = (await client.query(sql, params)).rows
          if (rows.length > 1) throw new Error(`Expected at most one row, got ${rows.length}`)
          return rows[0] ?? null
        },
      })
      await client.query('COMMIT')
      return result
    } catch (err) {
      // Rollback failures are swallowed deliberately: the original error is the one worth
      // reporting, and a broken connection cannot roll back anyway.
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
      observePool()
    }
  }

  /** Cheap liveness query for the readiness probe. */
  async function ping() {
    await query('SELECT 1')
  }

  async function close() {
    await pool.end()
  }

  return { query, one, transaction, ping, close, pool }
}
