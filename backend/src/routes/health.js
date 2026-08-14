/**
 * Liveness and readiness, which are different questions and need different answers.
 *
 * `/api/health` is liveness: is this process running and able to answer? It touches nothing
 * else on purpose. An orchestrator restarts a container that fails liveness, so a probe that
 * depends on the database would turn a slow query into a restart loop.
 *
 * `/api/ready` is readiness: should this process receive traffic right now? That does depend
 * on DuckDB — a backend whose database handle is broken serves 500s to every real route, so
 * it should be pulled out of rotation — and on whether we are draining. During shutdown we
 * report not-ready first and keep serving in-flight work, which is what lets a load balancer
 * stop sending new requests before the listener actually closes.
 */
import { Router } from 'express'

/**
 * @param {object} db open DuckDB handle
 * @param {object} [options]
 * @param {() => boolean} [options.isDraining] true once shutdown has begun
 */
export function healthRouter(db, { isDraining = () => false } = {}) {
  const router = Router()

  router.get('/api/health', (req, res) => res.json({ ok: true }))

  router.get('/api/ready', async (req, res) => {
    if (isDraining()) {
      return res.status(503).json({ ok: false, status: 'draining' })
    }
    try {
      await db.all('SELECT 1')
      return res.json({ ok: true, status: 'ready' })
    } catch (err) {
      // Logged in full here rather than passed to the error handler: a readiness failure is
      // an operational event, and the body stays a fixed shape the probe can rely on.
      console.error('Readiness check failed', err)
      return res.status(503).json({ ok: false, status: 'database_unavailable' })
    }
  })

  return router
}
