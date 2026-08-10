/**
 * API-key authentication for everything under /api.
 *
 * The platform proxies a paid Groq key and serves full ledgers, positions and counterparty
 * settlement instructions. None of that should be readable by anyone who can reach the port,
 * so every /api route except the health probe requires a shared key.
 *
 * The key comes from `API_KEY`. When it is not set, `server.js` mints a random one at boot
 * and prints it rather than falling open — an unconfigured deployment is the case that
 * actually happens, so it has to be the safe one. Tests construct the app with no key at all,
 * which disables the check; that is deliberate and only reachable in-process, never over a
 * socket, because the server always supplies one.
 */
import { timingSafeEqual } from 'node:crypto'

/** Constant-time compare that tolerates length mismatch without leaking it through timing. */
function keysMatch(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Presented credential: `X-API-Key`, or a bearer token, whichever the caller used. */
function presentedKey(req) {
  const header = req.get('x-api-key')
  if (header) return header
  const auth = req.get('authorization')
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
  return null
}

/**
 * @param {string|null} apiKey the configured key; a falsy value disables the check entirely
 * @param {string[]} publicPaths exact paths that stay open (liveness probes and /metrics,
 *   which Prometheus scrapes without credentials from inside the network)
 */
export function apiKeyAuth(apiKey, publicPaths = ['/api/health', '/metrics']) {
  const open = new Set(publicPaths)

  return function apiKeyAuthMiddleware(req, res, next) {
    if (!apiKey) return next()
    if (open.has(req.path)) return next()
    if (!req.path.startsWith('/api')) return next()

    const presented = presentedKey(req)
    if (!presented) {
      return res.status(401).json({
        error: 'Missing API key. Send it as X-API-Key or Authorization: Bearer <key>.',
        kind: 'unauthorized',
      })
    }
    if (!keysMatch(presented, apiKey)) {
      return res.status(403).json({ error: 'Invalid API key.', kind: 'forbidden' })
    }
    return next()
  }
}
