import { z } from 'zod'
import { callGroqForJson } from './llmJson.js'

const CopilotAnswerSchema = z.object({
  answer: z.string().min(15).max(1200),
  usedFacts: z.array(z.string()).max(10).default([]),
})

const SYSTEM_PROMPT = `You are the Reporting & Charting Agent's research copilot for a
trading platform. You answer questions ONLY using the JSON facts about the portfolio given
to you in the user message — never invent prices, positions, or P&L that aren't present in
those facts. If the facts don't contain what's needed to answer, say so plainly instead of
guessing. Always answer in at least one complete sentence (never a bare symbol or number
with no explanation), and list the fact strings you relied on in usedFacts.`

/**
 * Answer a natural-language question grounded in a caller-supplied facts object (e.g.
 * current positions/P&L). Returns a schema-validated { answer, usedFacts } object, or
 * throws LlmValidationError if the model can't produce valid output within a few retries.
 */
export async function answerCopilotQuery({ question, facts }, opts = {}) {
  const trimmed = (question ?? '').trim()
  if (!trimmed) {
    throw new Error('question is required')
  }

  const userPrompt = `Facts (JSON):\n${JSON.stringify(facts, null, 2)}\n\nQuestion: ${trimmed}`
  const { data, attempts } = await callGroqForJson({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    schema: CopilotAnswerSchema,
    ...opts,
  })

  return { ...data, attempts }
}

export { CopilotAnswerSchema }
