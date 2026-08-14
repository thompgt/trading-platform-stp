/**
 * Request correlation and the access log.
 *
 * Every request gets an id — the caller's `X-Request-Id` when it supplied one, otherwise a
 * fresh UUID — which is echoed back on the response, attached to `req.id`, and stamped on
 * every log line the request produces, including the one the error handler writes. That is
 * what turns "a user says something broke at 14:02" into a single grep. Without it, a failure
 * in a shared log is one stack trace with no way back to the request that caused it.
 *
 * A caller-supplied id is length-capped and stripped of anything but URL-safe characters:
 * it is untrusted input that ends up in log lines, and an unbounded one is both a forgery
 * vector for log-injection and a way to bloat every record.
 *
 * The line is written on `finish` *and* `close`, so a client that hangs up mid-response is
 * recorded rather than silently vanishing — an aborted request looks identical to a fast one
 * if you only ever log completions.
 */
import { randomUUID } from 'node:crypto'
import { logger as defaultLogger } from '../lib/logger.js'
import { routeLabel } from '../metrics/httpMetrics.js'

const MAX_ID_LENGTH = 64
const SAFE_ID = /^[A-Za-z0-9._-]+$/

/** Accept a caller's correlation id only if it is short and URL-safe; otherwise mint one. */
export function resolveRequestId(raw, generate = randomUUID) {
  if (typeof raw !== 'string') return generate()
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_ID_LENGTH || !SAFE_ID.test(trimmed)) return generate()
  return trimmed
}

/** Probes and scrapes run constantly; logging each one buries everything that matters. */
function isNoisyPath(path) {
  return path === '/api/health' || path === '/api/ready' || path === '/metrics'
}

/**
 * @param {object} [options]
 * @param {object} [options.logger] structured logger
 * @param {() => string} [options.generateId] id source, injected for tests
 */
export function requestLog({ logger = defaultLogger, generateId = randomUUID } = {}) {
  return function requestLogMiddleware(req, res, next) {
    const startedAt = process.hrtime.bigint()
    // Snapshot the path now: Express rewrites `req.url` while a router is dispatching, and
    // the 'finish' listener can run before it is restored.
    const path = req.path
    req.id = resolveRequestId(req.get('x-request-id'), generateId)
    // Bound before the routes so anything downstream — including the error handler — can log
    // against the request without re-deriving the id.
    req.log = logger.child({ requestId: req.id })
    res.setHeader('X-Request-Id', req.id)

    let settled = false
    const done = (event) => () => {
      if (settled) return
      settled = true
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      const fields = {
        method: req.method,
        route: routeLabel(req),
        path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ip: req.ip,
        ...(event === 'close' ? { aborted: true } : {}),
      }
      // A 5xx is the operator's problem, a 4xx is the caller's; only the first is an error.
      if (res.statusCode >= 500) req.log.error('request failed', fields)
      else if (isNoisyPath(path)) req.log.debug('request', fields)
      else req.log.info('request', fields)
    }

    res.on('finish', done('finish'))
    res.on('close', done('close'))
    return next()
  }
}
