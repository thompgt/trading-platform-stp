import { z } from 'zod'
import { callGroqForJson } from './llmJson.js'

// Mirrors the strategy shapes strategyRunner.js knows how to execute (workplan.md §7
// guardrail: the model proposes parameters, it never proposes executable code).
const StrategySchema = z.object({
  name: z.string().min(3).max(80),
  rationale: z.string().min(10).max(600),
  kind: z.enum(['sma_crossover', 'rsi_threshold']),
  params: z.union([
    z.object({
      fastPeriod: z.number().int().min(2).max(50),
      slowPeriod: z.number().int().min(3).max(200),
    }),
    z.object({
      period: z.number().int().min(2).max(50),
      oversold: z.number().min(0).max(50),
      overbought: z.number().min(50).max(100),
    }),
  ]),
})

const SYSTEM_PROMPT = `You are the Strategy Generation Agent for a paper-trading platform.
You propose ONE simple, well-known technical strategy for a symbol, chosen from exactly
two supported kinds:
- "sma_crossover": params { fastPeriod, slowPeriod } (both integers, fastPeriod < slowPeriod)
- "rsi_threshold": params { period, oversold, overbought } (oversold < overbought)
You never propose anything outside these two kinds, and you never include executable code.
Keep the rationale concise and specific to the symbol/context given.`

/**
 * Ask Groq to propose a paper-trading strategy for a symbol. Returns a schema-validated
 * strategy object ready to hand to strategyRunner.runStrategy — or throws LlmValidationError
 * if the model can't produce valid output within a few retries.
 */
export async function generateStrategy({ symbol, context = '' }, opts = {}) {
  const userPrompt = `Symbol: ${symbol}\n${context ? `Context: ${context}\n` : ''}Propose one strategy.`
  const { data, attempts } = await callGroqForJson({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    schema: StrategySchema,
    agent: 'strategy_generation',
    ...opts,
  })

  if (data.kind === 'sma_crossover' && data.params.fastPeriod >= data.params.slowPeriod) {
    throw new Error('Invalid strategy: fastPeriod must be less than slowPeriod')
  }
  if (data.kind === 'rsi_threshold' && data.params.oversold >= data.params.overbought) {
    throw new Error('Invalid strategy: oversold must be less than overbought')
  }

  return { strategy: data, attempts }
}

export { StrategySchema }
