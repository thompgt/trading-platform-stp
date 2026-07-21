import { get, post, put } from './client.js'

export const listSymbols = () => get('/data/symbols')
export const fetchMarketData = (symbol, period1, period2) =>
  post('/data/fetch', { symbol, period1, period2 })
export const getBars = (symbol, { start, end } = {}) => {
  const params = new URLSearchParams()
  if (start) params.set('start', start)
  if (end) params.set('end', end)
  const qs = params.toString()
  return get(`/data/bars/${symbol}${qs ? `?${qs}` : ''}`)
}

export const startSimulation = ({ symbol, start, end, strategy, startingCash }) =>
  post('/simulation/start', { symbol, start, end, strategy, startingCash })
export const getSimulationState = (sessionId) => get(`/simulation/${sessionId}/state`)
export const stepSimulation = (sessionId, n = 1) => post(`/simulation/${sessionId}/step`, { n })
export const rewindSimulation = (sessionId, n = 1) => post(`/simulation/${sessionId}/rewind`, { n })
export const jumpSimulation = (sessionId, date) => post(`/simulation/${sessionId}/jump`, { date })
export const resetSimulation = (sessionId) => post(`/simulation/${sessionId}/reset`, {})
export const setSimulationStrategy = (sessionId, strategy) =>
  put(`/simulation/${sessionId}/strategy`, { strategy })

export const generateStrategy = (symbol, context) => post('/strategy/generate', { symbol, context })
export const askCopilot = (question, facts) => post('/copilot/ask', { question, facts })

export const getSessionRisk = (sessionId) => get(`/simulation/${sessionId}/risk`)
export const getSessionCompliance = (sessionId) => get(`/simulation/${sessionId}/compliance`)
