import { Router } from 'express'
import { generateStrategy } from '../agents/strategyAgent.js'
import { LlmValidationError, LlmTimeoutError } from '../agents/llmJson.js'
import { validate } from '../middleware/validate.js'
import { generateStrategyBody } from '../schemas/requests.js'

export function strategyRouter() {
  const router = Router()

  router.post('/generate', validate(generateStrategyBody), async (req, res, next) => {
    const { symbol, context } = req.body
    try {
      const { strategy, attempts } = await generateStrategy({ symbol, context })
      res.json({ strategy, attempts })
    } catch (err) {
      if (err instanceof LlmTimeoutError) {
        return res.status(504).json({ error: err.message, kind: 'llm_timeout' })
      }
      if (err instanceof LlmValidationError) {
        return res.status(502).json({ error: err.message, kind: 'llm_validation_failed' })
      }
      next(err)
    }
  })

  return router
}
