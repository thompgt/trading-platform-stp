/**
 * One place where request bodies are checked against a zod schema.
 *
 * zod was already a dependency, used to validate everything coming *out* of the LLM, and
 * nothing coming *in* from a client. That asymmetry is backwards: the model is prompted and
 * retried, an HTTP caller is not. Untyped bodies reached the engine directly — a fractional
 * `n` indexed into `bars.slice`, and any array at all was accepted as a batch of fills.
 *
 * Validation replaces the body with the parsed value, so handlers read coerced, defaulted,
 * trusted data rather than re-checking `req.body ?? {}` themselves.
 */

/** Flatten zod issues into "path: message" strings a caller can act on. */
function describe(error) {
  return error.issues.map((issue) => {
    const path = issue.path.join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
}

/**
 * @param {import('zod').ZodType} schema
 * @param {'body'|'query'} source which part of the request to validate
 */
export function validate(schema, source = 'body') {
  return function validateMiddleware(req, res, next) {
    const result = schema.safeParse(source === 'query' ? req.query : (req.body ?? {}))
    if (!result.success) {
      const details = describe(result.error)
      return res.status(400).json({
        // The first issue is the headline so a UI has something short to show; the rest are
        // there for a caller fixing more than one thing at once.
        error: details[0],
        kind: 'invalid_request',
        details,
      })
    }
    if (source === 'query') {
      req.validatedQuery = result.data
    } else {
      req.body = result.data
    }
    return next()
  }
}
