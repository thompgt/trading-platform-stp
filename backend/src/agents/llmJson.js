import { getGroqClient, getGroqModel } from './groqClient.js'
import {
  llmRequestsTotal,
  llmRequestDuration,
  llmValidationRetriesTotal,
} from '../metrics/registry.js'

export class LlmValidationError extends Error {
  constructor(message, attempts) {
    super(message)
    this.name = 'LlmValidationError'
    this.attempts = attempts
  }
}

/**
 * Raised when Groq did not answer in time — distinct from a schema failure, because the
 * remedy is different: a validation failure is the model's fault and retrying may help, a
 * timeout is the upstream's and the caller should be told to try later.
 */
export class LlmTimeoutError extends Error {
  constructor(message, attempts) {
    super(message)
    this.name = 'LlmTimeoutError'
    this.attempts = attempts
  }
}

/** Per-attempt ceiling, and a ceiling on all attempts together. Both env-tunable. */
export const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 20_000)
export const DEFAULT_DEADLINE_MS = Number(process.env.LLM_DEADLINE_MS ?? 45_000)

/**
 * Call Groq's chat completions API asking for a JSON object, validate the result against
 * a zod schema, and retry (with the validation error fed back to the model) if it doesn't
 * validate. Never returns unvalidated data — callers can trust the shape of the result.
 */
export async function callGroqForJson({
  systemPrompt,
  userPrompt,
  schema,
  maxAttempts = 3,
  client,
  // Labels the Prometheus series so per-agent latency and failure rates are separable.
  agent = 'unknown',
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  deadlineMs = DEFAULT_DEADLINE_MS,
}) {
  const groq = client ?? getGroqClient()
  const model = getGroqModel()
  // Spans the whole call including retries — that's the latency a user actually waits.
  const endTimer = llmRequestDuration.startTimer({ agent })

  const messages = [
    { role: 'system', content: `${systemPrompt}\n\nRespond with a single JSON object only, no prose, no markdown fences.` },
    { role: 'user', content: userPrompt },
  ]

  let lastError = null

  // Two bounds, because one is not enough. The per-request timeout stops a single hung
  // socket; the deadline stops three merely-slow attempts from adding up to a request the
  // handler holds open for a minute. Without either, a stalled upstream pinned the Express
  // handler indefinitely.
  const deadlineAt = Date.now() + deadlineMs

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) {
        endTimer()
        llmRequestsTotal.inc({ agent, outcome: 'timeout' })
        throw new LlmTimeoutError(
          `Groq did not respond within ${deadlineMs}ms across ${attempt - 1} attempt(s)`,
          attempt - 1,
        )
      }

      let completion
      try {
        completion = await groq.chat.completions.create(
          {
            model,
            messages,
            response_format: { type: 'json_object' },
            temperature: 0.4,
          },
          { signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)) },
        )
      } catch (err) {
        // An abort is the timeout firing; anything else is a real transport error and is
        // re-thrown for the outer handler to count as such.
        if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
          endTimer()
          llmRequestsTotal.inc({ agent, outcome: 'timeout' })
          throw new LlmTimeoutError(
            `Groq did not respond within ${Math.min(requestTimeoutMs, remaining)}ms on attempt ${attempt}`,
            attempt,
          )
        }
        throw err
      }

      const raw = completion.choices?.[0]?.message?.content ?? ''

      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        lastError = `Response was not valid JSON: ${raw.slice(0, 200)}`
        llmValidationRetriesTotal.inc({ agent })
        messages.push({ role: 'assistant', content: raw })
        messages.push({ role: 'user', content: `That was not valid JSON. ${lastError}. Reply again with valid JSON only.` })
        continue
      }

      const result = schema.safeParse(parsed)
      if (result.success) {
        endTimer()
        llmRequestsTotal.inc({ agent, outcome: 'success' })
        return { data: result.data, attempts: attempt, raw }
      }

      lastError = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      llmValidationRetriesTotal.inc({ agent })
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user',
        content: `That JSON didn't match the required schema (${lastError}). Reply again with corrected JSON only.`,
      })
    }
  } catch (err) {
    // A timeout has already ended the timer and counted itself under its own outcome.
    if (err instanceof LlmTimeoutError) throw err
    // Transport/API failure rather than a schema problem — distinguished in the metric so
    // "Groq is down" and "Groq is rambling" don't look alike on the dashboard.
    endTimer()
    llmRequestsTotal.inc({ agent, outcome: 'error' })
    throw err
  }

  endTimer()
  llmRequestsTotal.inc({ agent, outcome: 'validation_failed' })
  throw new LlmValidationError(`LLM did not return valid JSON after ${maxAttempts} attempts: ${lastError}`, maxAttempts)
}
