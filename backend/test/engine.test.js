import { describe, it, expect } from 'vitest'
import { SimulationEngine } from '../src/simulation/engine.js'

function makeBars(n) {
  const start = new Date('2024-01-01')
  return Array.from({ length: n }, (_, i) => {
    const ts = new Date(start)
    ts.setDate(ts.getDate() + i)
    const close = 100 + i
    return { ts, open: close, high: close, low: close, close, volume: 100 }
  })
}

describe('SimulationEngine', () => {
  it('throws when constructed with no bars', () => {
    expect(() => new SimulationEngine([])).toThrow(/at least one bar/)
  })

  it('starts with nothing revealed', () => {
    const engine = new SimulationEngine(makeBars(5))
    expect(engine.state().currentBar).toBeNull()
    expect(engine.state().cursor).toBe(0)
  })

  it('reveals one more bar per step', () => {
    const engine = new SimulationEngine(makeBars(5))
    engine.step()
    expect(engine.state().cursor).toBe(1)
    expect(engine.state().currentBar.close).toBe(100)
    engine.step()
    expect(engine.state().currentBar.close).toBe(101)
  })

  it('clamps stepping past the end instead of throwing', () => {
    const engine = new SimulationEngine(makeBars(3))
    engine.step(10)
    expect(engine.state().cursor).toBe(3)
    expect(engine.state().isAtEnd).toBe(true)
    engine.step(1)
    expect(engine.state().cursor).toBe(3)
  })

  it('rewinds without going negative', () => {
    const engine = new SimulationEngine(makeBars(5))
    engine.step(2)
    engine.rewind(10)
    expect(engine.state().cursor).toBe(0)
    expect(engine.state().currentBar).toBeNull()
  })

  it('jumps to a given date and can then resimulate forward from there', () => {
    const engine = new SimulationEngine(makeBars(10))
    engine.jumpToDate('2024-01-05')
    expect(engine.state().currentBar.ts.toISOString().slice(0, 10)).toBe('2024-01-05')
    engine.step()
    expect(engine.state().currentBar.ts.toISOString().slice(0, 10)).toBe('2024-01-06')
  })

  it('jumping past the last bar date reveals everything, and says so', () => {
    const engine = new SimulationEngine(makeBars(5))
    const state = engine.jumpToDate('2099-01-01')
    expect(state.isAtEnd).toBe(true)
    expect(state.jumpedPastLastBar).toBe(true)
  })

  it('throws on an unparseable date instead of fast-forwarding to the end', () => {
    const engine = new SimulationEngine(makeBars(10))
    engine.step(3)

    for (const bad of ['not-a-date', '2024-13-45', '', 'Jan the fifth']) {
      expect(() => engine.jumpToDate(bad)).toThrowError(/Invalid date/)
    }
    // The failed jump must not have moved the cursor.
    expect(engine.state().cursor).toBe(3)
  })

  it('does not flag a successful jump as having run off the end', () => {
    const engine = new SimulationEngine(makeBars(10))
    expect(engine.jumpToDate('2024-01-05').jumpedPastLastBar).toBe(false)
  })

  it('reset returns to the start so the market can be resimulated from scratch', () => {
    const engine = new SimulationEngine(makeBars(5))
    engine.step(5)
    engine.reset()
    expect(engine.state().cursor).toBe(0)
  })

  it('re-running a strategy after rewinding produces a shorter, consistent trade history', () => {
    const strategy = { kind: 'sma_crossover', params: { fastPeriod: 2, slowPeriod: 3 } }
    const engine = new SimulationEngine(makeBars(10), { strategy })
    engine.step(10)
    const fullTrades = engine.state().trades.length

    engine.rewind(5)
    const partialTrades = engine.state().trades.length
    expect(partialTrades).toBeLessThanOrEqual(fullTrades)

    engine.step(5)
    expect(engine.state().trades.length).toBe(fullTrades)
  })
})
