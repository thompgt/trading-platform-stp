import { Router } from 'express'
import { answerCopilotQuery } from '../agents/copilotAgent.js'
import { LlmValidationError, LlmTimeoutError } from '../agents/llmJson.js'
import { validate } from '../middleware/validate.js'
import { copilotAskBody } from '../schemas/requests.js'

export function copilotRouter() {
  const router = Router()

  router.post('/ask', validate(copilotAskBody), async (req, res, next) => {
    const { question, facts } = req.body
    try {
      const result = await answerCopilotQuery({ question, facts: facts ?? {} })
      res.json(result)
    } catch (err) {
      if (err instanceof LlmTimeoutError) {
        return res.status(504).json({ error: err.message, kind: 'llm_timeout' })
      }
      if (err instanceof LlmValidationError) {
        return res.status(502).json({ error: err.message, kind: 'llm_validation_failed' })
      }
      // Anything not a timeout or a schema failure is ours, not the caller's — a missing
      // API key, a transport error — so it is a 500 with nothing quoted back.
      next(err)
    }
  })

  return router
}
