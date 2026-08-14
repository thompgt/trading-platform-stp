/**
 * One place that decides what a failure looks like from outside.
 *
 * The rule is deliberately blunt: a client is told what went wrong **only when we chose the
 * status ourselves**. An error carrying an explicit 4xx — an unknown session, a bad jump
 * date, a body we rejected — was raised by our own code with wording written for a caller,
 * so its message is safe and useful. Anything else reached the handler by accident: a
 * DuckDB parse error, a filesystem path, a stack from a library. Those become a flat
 * `Internal server error`, because the message is a map of the server's internals and the
 * caller can do nothing with it anyway.
 *
 * The full error is always logged against the request's id. Nothing is lost, it just stops
 * being published — and the caller gets that id back so the two can be joined later.
 */

import { logger } from '../lib/logger.js'

/** An error the client is allowed to read, with the status we intend to return. */
export function httpError(status, message, options = {}) {
  const err = new Error(message, options.cause ? { cause: options.cause } : undefined)
  err.status = status
  err.expose = true
  if (options.kind) err.kind = options.kind
  return err
}

/** Shorthand for the common case: a request we are refusing. */
export function badRequest(message, options = {}) {
  return httpError(400, message, options)
}

/**
 * The last-resort handler. Mounted after every router, and the single place any route
 * should send a failure — `next(err)` rather than composing a response in the catch.
 */
export function errorHandler() {
  return (err, req, res, _next) => {
    const status = Number.isInteger(err?.status) ? err.status : 500
    // `expose` can be set explicitly; otherwise a status under 500 is one we picked.
    const expose = typeof err?.expose === 'boolean' ? err.expose : status < 500
    const message = expose && err?.message ? err.message : 'Internal server error'

    // Logged against the request's own id, so the flat `Internal server error` a caller sees
    // can be traced to the real stack without publishing it.
    const log = req.log ?? logger
    log.error('request error', {
      method: req.method,
      path: req.originalUrl,
      status,
      err,
    })

    if (res.headersSent) return

    const body = { error: message }
    if (err?.kind) body.kind = err.kind
    if (err?.details) body.details = err.details
    // Given to the caller on purpose: it is the handle they quote when reporting the failure.
    if (req.id) body.requestId = req.id
    res.status(status).json(body)
  }
}
