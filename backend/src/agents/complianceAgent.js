import { z } from 'zod'
import { callGroqForJson } from './llmJson.js'

/**
 * Compliance Surveillance Agent (workplan.md §5/§7: gen-AI-assisted, draft-only — the
 * agent triages and drafts, a human reviews/files). Pattern detection itself is
 * deterministic rules over the trade blotter (never the model's job to "notice" a
 * pattern); Groq is only used to turn an already-detected pattern into a triage
 * narrative a compliance officer can read quickly.
 */

const TriageSchema = z.object({
  explanation: z.string().min(15).max(700),
  recommendation: z.string().min(10).max(400),
})

const SYSTEM_PROMPT = `You are the Compliance Surveillance Agent's triage assistant for a
trading platform. You are given a deterministically-detected order/trade pattern (never
invent one) and must draft a short triage explanation and a recommended next step for a
human compliance officer. You never state that a violation has occurred — only describe
the pattern and suggest what a human should check. This is a draft; it is never auto-filed.

Respond with a JSON object with exactly these two string fields:
- "explanation": a concise description of the detected pattern and why it was flagged
- "recommendation": a specific next step for a human compliance officer to take
Do not use any other field names, and do not nest these under another key.`

/** Deterministic pattern detection over a session's trade blotter. Exported for testing. */
export function detectPatterns(trades = []) {
  const patterns = []

  // Rapid reversal: opposite-side trade within 2 bars of the previous one, repeated —
  // a simplified proxy for churn/wash-trade-adjacent activity.
  let reversals = 0
  for (let i = 1; i < trades.length; i++) {
    if (trades[i].side !== trades[i - 1].side) reversals++
  }
  if (trades.length >= 4 && reversals >= trades.length - 1) {
    patterns.push({
      id: 'rapid-reversal',
      pattern: 'Rapid buy/sell reversal pattern',
      severity: reversals >= 6 ? 'high' : 'medium',
      facts: [`${trades.length} trades`, `${reversals} side reversals`],
    })
  }

  // Outsized single trade relative to the *other* trades' average size (excluding the
  // candidate itself, so a single dominant trade can't inflate its own baseline away).
  if (trades.length >= 3) {
    const totalQty = trades.reduce((s, t) => s + t.qty, 0)
    const outsized = trades.filter((t) => {
      const othersAvg = (totalQty - t.qty) / (trades.length - 1)
      return othersAvg > 0 && t.qty >= othersAvg * 3
    })
    if (outsized.length > 0) {
      const othersAvgLabel = (totalQty - outsized[0].qty) / (trades.length - 1)
      patterns.push({
        id: 'outsized-trade',
        pattern: 'Outsized order relative to session average',
        severity: 'low',
        facts: outsized.map((t) => `${t.side} ${t.qty} @ ${t.price} (peer avg ${othersAvgLabel.toFixed(0)})`),
      })
    }
  }

  return patterns
}

/**
 * Detect patterns in a session's trades and, for each one found, ask Groq to draft a
 * triage narrative. Returns [] if no patterns are detected (no LLM call made). Throws
 * LlmValidationError if the model can't produce valid output within a few retries.
 */
export async function draftComplianceTriage({ symbol, trades }, opts = {}) {
  const patterns = detectPatterns(trades)
  if (patterns.length === 0) return []

  const drafts = []
  for (const pattern of patterns) {
    const userPrompt = `Symbol: ${symbol}\nDetected pattern: ${pattern.pattern}\nSupporting facts: ${pattern.facts.join('; ')}`
    const { data } = await callGroqForJson({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      schema: TriageSchema,
      agent: 'compliance_surveillance',
      ...opts,
    })
    drafts.push({
      id: `CMP-${pattern.id}-${symbol}`,
      severity: pattern.severity,
      pattern: pattern.pattern,
      symbol,
      status: 'Pending compliance review',
      aiDraft: `${data.explanation} Recommendation: ${data.recommendation} This is an AI-drafted triage summary — not a filing.`,
    })
  }
  return drafts
}

export { TriageSchema }
