/**
 * A small fixed-window rate limiter, kept dependency-free like the rest of this repo.
 *
 * It exists for one reason: the LLM routes spend the operator's money. A caller who can loop
 * on POST /api/copilot/ask can run up a Groq bill regardless of whether their key is valid,
 * so those routes are capped per key/IP per window on top of authentication.
 *
 * Counters live in a Map that is swept on write, so an idle process does not hold windows for
 * callers it will never see again. Single-process only — a real deployment would put this in
 * Redis — but the failure mode of the in-memory version is "limit is per instance", not
 * "limit silently does nothing".
 */

/** Who the limit applies to: the API key if there is one, otherwise the peer address. */
function callerKey(req) {
  return req.get('x-api-key') || req.get('authorization') || req.ip || 'anonymous'
}

/**
 * @param {object} [options]
 * @param {number} [options.windowMs] window length; defaults to a minute
 * @param {number} [options.max] requests allowed per caller per window
 */
export function rateLimit({ windowMs = 60_000, max = 20 } = {}) {
  const hits = new Map()

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now()

    // Sweep expired windows first, so the Map tracks active callers rather than every caller
    // the process has ever seen — the same unbounded-growth trap the session maps had.
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key)
    }

    const key = callerKey(req)
    const entry = hits.get(key) ?? { count: 0, resetAt: now + windowMs }
    entry.count += 1
    hits.set(key, entry)

    const remaining = Math.max(0, max - entry.count)
    res.setHeader('RateLimit-Limit', String(max))
    res.setHeader('RateLimit-Remaining', String(remaining))
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)))

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)))
      return res.status(429).json({
        error: `Rate limit exceeded: at most ${max} requests per ${Math.round(windowMs / 1000)}s.`,
        kind: 'rate_limited',
      })
    }
    return next()
  }
}
