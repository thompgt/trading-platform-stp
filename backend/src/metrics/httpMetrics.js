import { httpRequestsTotal, httpRequestDuration, httpRequestsInFlight } from './registry.js'

/**
 * Resolve the *route pattern* a request matched, never the raw URL.
 *
 * This matters more than it looks: simulation paths carry a UUID session id, so labelling
 * with `req.path` would mint a fresh Prometheus time series per session and blow up
 * cardinality within an afternoon. `/api/simulation/:id/step` stays one series forever.
 */
export function routeLabel(req) {
  if (req.route?.path) {
    const base = req.baseUrl || ''
    const path = req.route.path === '/' ? '' : req.route.path
    return `${base}${path}` || '/'
  }
  // No route matched (404s, and the /metrics endpoints mounted directly on the app).
  return req.path === '/metrics' ? '/metrics' : 'unmatched'
}

/** Express middleware recording request count, latency, and in-flight depth. */
export function httpMetricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer()
  httpRequestsInFlight.inc()

  // 'finish' covers normal responses; 'close' catches clients that hang up early, so the
  // in-flight gauge can't drift upward and permanently look like a stuck backend.
  let settled = false
  const done = () => {
    if (settled) return
    settled = true
    httpRequestsInFlight.dec()
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status: String(res.statusCode),
    }
    end(labels)
    httpRequestsTotal.inc(labels)
  }

  res.on('finish', done)
  res.on('close', done)
  next()
}
