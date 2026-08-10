/**
 * Request body schemas, kept together so the API's accepted shapes can be read in one place.
 *
 * Messages are written to be shown to a caller as-is, and deliberately match the wording the
 * hand-rolled checks used, so the API's error text does not change under anyone.
 */
import { z } from 'zod'
import { STRATEGY_KINDS } from '../simulation/strategyRunner.js'

/** A non-empty ticker. Upper-casing stays in the handlers, which already do it. */
const symbol = z.string().trim().min(1, 'symbol is required').max(20)

/**
 * Cursor movements are counts of bars. A fractional `n` used to flow straight into
 * `bars.slice`, which silently truncates — the replay then sat at a position no caller
 * asked for. Integers only.
 */
const barCount = z
  .number({ message: 'n must be a number' })
  .int('n must be a whole number of bars')
  .min(-100_000)
  .max(100_000)

/** An execution as the settlement procedure expects one. */
const fill = z.object({
  ts: z.union([z.string(), z.date()]),
  side: z.enum(['BUY', 'SELL'], { message: 'side must be BUY or SELL' }),
  qty: z.number().positive('qty must be positive'),
  price: z.number().nonnegative('price cannot be negative'),
})

export const strategyDefinition = z.object({
  kind: z.enum(STRATEGY_KINDS, {
    message: `strategy.kind must be one of ${STRATEGY_KINDS.join(', ')}`,
  }),
  params: z.record(z.string(), z.number()).optional(),
})

// --- /api/data ------------------------------------------------------------------------

export const fetchBarsBody = z.object({
  symbol,
  period1: z.union([z.string().min(1), z.date()], { message: 'period1 is required' }),
  period2: z.union([z.string().min(1), z.date()], { message: 'period2 is required' }),
  interval: z.string().min(1).optional(),
})

// --- /api/simulation ------------------------------------------------------------------

export const startSessionBody = z.object({
  symbol,
  start: z.string().min(1).optional(),
  end: z.string().min(1).optional(),
  strategy: strategyDefinition.nullish(),
  startingCash: z.number().positive('startingCash must be positive').optional(),
})

export const stepBody = z.object({ n: barCount.optional() })

export const jumpBody = z.object({
  date: z.string({ message: 'date is required' }).min(1, 'date is required'),
})

export const setStrategyBody = z.object({ strategy: strategyDefinition })

// --- /api/settlement ------------------------------------------------------------------

/**
 * `symbol` and `fills` are optional here because either may come from a replay session
 * instead; the handler decides whether enough was supplied, and keeps its own wording. What
 * this schema does enforce is that anything that *is* supplied has the right shape — the
 * route used to accept literally any array as a batch of executions.
 *
 * `runId` is absent on purpose. It is minted server-side, and a schema that silently strips
 * it is the clearest possible statement that a caller cannot choose one.
 */
export const settlementRunBody = z.object({
  sessionId: z.string().min(1).nullish(),
  symbol: symbol.optional(),
  fills: z.array(fill, { message: 'fills must be an array' }).optional(),
  startingCash: z.number().nonnegative('startingCash cannot be negative').optional(),
  valuationDate: z.string().min(1).nullish(),
  confirmDiscrepancies: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  failedTradeIds: z.array(z.string()).optional(),
  custodianDiscrepancies: z.record(z.string(), z.number()).optional(),
})

// --- Gen-AI routes --------------------------------------------------------------------

export const generateStrategyBody = z.object({
  symbol,
  context: z.string().max(4000).optional(),
})

export const copilotAskBody = z.object({
  question: z.string({ message: 'question is required' }).trim().min(1, 'question is required').max(2000),
  // Free-form facts JSON supplied by the caller and passed to the model as grounding; the
  // shape is the caller's business, the size is not.
  facts: z.unknown().optional(),
})
