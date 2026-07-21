import express from 'express'
import cors from 'cors'
import { dataRouter } from './routes/data.js'
import { simulationRouter } from './routes/simulation.js'
import { strategyRouter } from './routes/strategy.js'
import { copilotRouter } from './routes/copilot.js'

export function createApp(db) {
  const app = express()
  app.use(cors())
  app.use(express.json())

  app.get('/api/health', (req, res) => res.json({ ok: true }))
  app.use('/api/data', dataRouter(db))
  app.use('/api/simulation', simulationRouter(db))
  app.use('/api/strategy', strategyRouter())
  app.use('/api/copilot', copilotRouter())

  // Last-resort handler: never leak stack traces, always return JSON.
  app.use((err, req, res, next) => {
    console.error(err)
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  })

  return app
}
