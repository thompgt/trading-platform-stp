import { runStrategy } from './strategyRunner.js'

/**
 * Replays a fixed series of bars bar-by-bar with a cursor, so the UI can step forward,
 * rewind, or jump to any point and re-run ("resimulate") a strategy from there. All bars
 * are loaded up front (from DuckDB) — this only replays already-cached market data, it
 * does not stream live quotes.
 */
export class SimulationEngine {
  constructor(bars, { strategy = null, startingCash = 100000 } = {}) {
    if (!Array.isArray(bars) || bars.length === 0) {
      throw new Error('SimulationEngine requires at least one bar')
    }
    this.bars = bars
    this.strategy = strategy
    this.startingCash = startingCash
    this.cursor = 0 // index of the *next* bar to reveal; 0 = nothing revealed yet
  }

  get length() {
    return this.bars.length
  }

  get isAtEnd() {
    return this.cursor >= this.bars.length
  }

  /** Bars revealed so far, oldest to newest. */
  visibleBars() {
    return this.bars.slice(0, this.cursor)
  }

  step(n = 1) {
    this.cursor = Math.min(this.bars.length, Math.max(0, this.cursor + n))
    return this.state()
  }

  rewind(n = 1) {
    return this.step(-n)
  }

  /** Jump so the bar at/after the given ISO date becomes the current (last revealed) bar. */
  jumpToDate(isoDate) {
    const target = new Date(isoDate).getTime()
    let idx = this.bars.findIndex((b) => new Date(b.ts).getTime() >= target)
    this.cursor = idx === -1 ? this.bars.length : idx + 1
    return this.state()
  }

  reset() {
    this.cursor = 0
    return this.state()
  }

  setStrategy(strategy) {
    this.strategy = strategy
    return this.state()
  }

  state() {
    const visible = this.visibleBars()
    const result = this.strategy
      ? runStrategy(this.strategy, visible, { startingCash: this.startingCash })
      : { trades: [], equityCurve: [], finalCash: this.startingCash, finalPosition: 0 }

    return {
      cursor: this.cursor,
      length: this.bars.length,
      isAtEnd: this.isAtEnd,
      currentBar: visible.length > 0 ? visible[visible.length - 1] : null,
      trades: result.trades,
      equityCurve: result.equityCurve,
      cash: result.finalCash,
      position: result.finalPosition,
    }
  }
}
