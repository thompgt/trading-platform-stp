import { Router } from 'express'
import { generateStrategy } from '../agents/strategyAgent.js'
import { LlmValidationError } from '../agents/llmJson.js'

export function strategyRouter() {
  const router = Router()

  router.post('/generate', async (req, res) => {
    const { symbol, context } = req.body ?? {}
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' })
    }
    try {
      const { strategy, attempts } = await generateStrategy({ symbol, context })
      res.json({ strategy, attempts })
    } catch (err) {
      if (err instanceof LlmValidationError) {
        return res.status(502).json({ error: err.message, kind: 'llm_validation_failed' })
      }
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
