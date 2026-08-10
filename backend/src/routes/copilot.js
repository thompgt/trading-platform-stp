import { Router } from 'express'
import { answerCopilotQuery } from '../agents/copilotAgent.js'
import { LlmValidationError, LlmTimeoutError } from '../agents/llmJson.js'

export function copilotRouter() {
  const router = Router()

  router.post('/ask', async (req, res) => {
    const { question, facts } = req.body ?? {}
    if (!question) {
      return res.status(400).json({ error: 'question is required' })
    }
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
      res.status(400).json({ error: err.message })
    }
  })

  return router
}
