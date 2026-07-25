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

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const completion = await groq.chat.completions.create({
        model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.4,
      })

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
