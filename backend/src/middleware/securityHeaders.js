/**
 * Baseline response security headers, kept dependency-free like the rest of this repo.
 *
 * This is a JSON API, not an HTML app, so the set is deliberately small and aimed at the
 * ways a JSON endpoint actually gets abused: a browser sniffing a response into something
 * executable, the API being framed, a key or run id leaking outbound in a `Referer`, and
 * intermediaries caching ledgers and positions that are scoped to one caller's key.
 *
 * `Strict-Transport-Security` is only emitted for requests that arrived over TLS. Sending it
 * on plain HTTP is at best ignored and at worst pins a developer's `localhost` to https for
 * a year, which is a genuinely painful thing to undo in a browser.
 */

/** A frame-ancestors-only CSP: there is no markup to constrain, only embedding. */
const CSP = "default-src 'none'; frame-ancestors 'none'"

/** True when the request reached us over TLS, directly or via a trusted proxy. */
function isSecure(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https'
}

export function securityHeaders() {
  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', CSP)
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site')
    // Responses are per-key and often per-run; nothing here should sit in a shared cache.
    res.setHeader('Cache-Control', 'no-store')
    // Express advertises itself by default, which tells an attacker what to target.
    res.removeHeader('X-Powered-By')
    if (isSecure(req)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    return next()
  }
}
