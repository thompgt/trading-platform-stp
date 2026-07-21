import { getGroqClient, getGroqModel } from './groqClient.js'

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
export async function callGroqForJson({ systemPrompt, userPrompt, schema, maxAttempts = 3, client }) {
  const groq = client ?? getGroqClient()
  const model = getGroqModel()

  const messages = [
    { role: 'system', content: `${systemPrompt}\n\nRespond with a single JSON object only, no prose, no markdown fences.` },
    { role: 'user', content: userPrompt },
  ]

  let lastError = null

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
      messages.push({ role: 'assistant', content: raw })
      messages.push({ role: 'user', content: `That was not valid JSON. ${lastError}. Reply again with valid JSON only.` })
      continue
    }

    const result = schema.safeParse(parsed)
    if (result.success) {
      return { data: result.data, attempts: attempt, raw }
    }

    lastError = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    messages.push({ role: 'assistant', content: raw })
    messages.push({
      role: 'user',
      content: `That JSON didn't match the required schema (${lastError}). Reply again with corrected JSON only.`,
    })
  }

  throw new LlmValidationError(`LLM did not return valid JSON after ${maxAttempts} attempts: ${lastError}`, maxAttempts)
}
