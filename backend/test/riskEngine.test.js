import { describe, it, expect } from 'vitest'
import { evaluateRisk } from '../src/agents/riskEngine.js'

describe('evaluateRisk', () => {
  it('returns no alerts for a small, low-volatility position', () => {
    const alerts = evaluateRisk({
      symbol: 'TEST',
      cash: 90000,
      position: 100,
      currentPrice: 100,
      startingCash: 100000,
      equityCurve: [
        { ts: '2024-01-01', equity: 100000 },
        { ts: '2024-01-02', equity: 100050 },
        { ts: '2024-01-03', equity: 100010 },
      ],
    })
    expect(alerts).toEqual([])
  })

  it('flags high concentration when the position dominates equity', () => {
    const alerts = evaluateRisk({
      symbol: 'TEST',
      cash: 1000,
      position: 900,
      currentPrice: 100,
      startingCash: 100000,
      equityCurve: [{ ts: '2024-01-01', equity: 91000 }],
    })
    const conc = alerts.find((a) => a.id === 'RSK-CONC-TEST')
    expect(conc).toBeTruthy()
    expect(conc.severity).toBe('high')
    expect(conc.agent).toBe('Pre-Trade Risk')
  })

  it('flags high drawdown when equity falls sharply from a peak', () => {
    const alerts = evaluateRisk({
      symbol: 'TEST',
      cash: 80000,
      position: 0,
      currentPrice: 0,
      startingCash: 100000,
      equityCurve: [
        { ts: '2024-01-01', equity: 100000 },
        { ts: '2024-01-02', equity: 120000 },
        { ts: '2024-01-03', equity: 90000 },
      ],
    })
    const dd = alerts.find((a) => a.id === 'RSK-DD-TEST')
    expect(dd).toBeTruthy()
    expect(dd.severity).toBe('high')
    expect(dd.agent).toBe('Market Risk')
  })

  it('sorts alerts most-severe first', () => {
    const alerts = evaluateRisk({
      symbol: 'TEST',
      cash: 100,
      position: 900,
      currentPrice: 100,
      startingCash: 100000,
      equityCurve: [
        { ts: '2024-01-01', equity: 100000 },
        { ts: '2024-01-02', equity: 130000 },
        { ts: '2024-01-03', equity: 90100 },
      ],
    })
    expect(alerts.length).toBeGreaterThan(1)
    const severityOrder = { high: 0, medium: 1, low: 2 }
    for (let i = 1; i < alerts.length; i++) {
      expect(severityOrder[alerts[i - 1].severity]).toBeLessThanOrEqual(severityOrder[alerts[i].severity])
    }
  })
})
