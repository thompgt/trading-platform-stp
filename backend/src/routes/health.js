/**
 * Liveness and readiness, which are different questions and need different answers.
 *
 * `/api/health` is liveness: is this process running and able to answer? It touches nothing
 * else on purpose. An orchestrator restarts a container that fails liveness, so a probe that
 * depends on the database would turn a slow query into a restart loop.
 *
 * `/api/ready` is readiness: should this process receive traffic right now? That depends on
 * both stores — a backend whose DuckDB handle is broken serves 500s to every analytics route
 * and one that cannot reach Postgres serves them to every order route, so either should pull
 * the instance out of rotation — and on whether we are draining. During shutdown we
 * report not-ready first and keep serving in-flight work, which is what lets a load balancer
 * stop sending new requests before the listener actually closes.
 */
import { Router } from 'express'

/**
 * @param {object} db open DuckDB handle
 * @param {object} [options]
 * @param {() => boolean} [options.isDraining] true once shutdown has begun
 * @param {object|null} [options.pg] Postgres handle; absent means the order domain is off
 */
export function healthRouter(db, { isDraining = () => false, pg = null } = {}) {
  const router = Router()

  router.get('/api/health', (req, res) => res.json({ ok: true }))

  router.get('/api/ready', async (req, res) => {
    if (isDraining()) {
      return res.status(503).json({ ok: false, status: 'draining' })
    }
    try {
      await db.all('SELECT 1')
    } catch (err) {
      console.error('Readiness check failed: DuckDB', err)
      return res.status(503).json({ ok: false, status: 'database_unavailable', store: 'duckdb' })
    }

    // Only checked when configured. Running without it is a supported development mode in
    // which the order routes are unavailable and everything else works; reporting not-ready
    // for a deliberately absent store would make that mode unusable.
    if (pg) {
      try {
        await pg.ping()
      } catch (err) {
        console.error('Readiness check failed: Postgres', err)
        return res.status(503).json({ ok: false, status: 'database_unavailable', store: 'postgres' })
      }
    }

    // Each store's failure is caught and logged at its own check above, rather than passed to
    // the error handler: a readiness failure is an operational event, and the body stays a
    // fixed shape the probe can rely on. `stores` reports what was actually verified.
    return res.json({ ok: true, status: 'ready', stores: pg ? ['duckdb', 'postgres'] : ['duckdb'] })
  })

  return router
}
