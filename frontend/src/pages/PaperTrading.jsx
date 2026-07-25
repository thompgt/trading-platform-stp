import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, Badge, StatTile } from '../components/ui.jsx'
import LineSeriesChart from '../components/charts/LineSeriesChart.jsx'
import {
  fetchMarketData,
  getBars,
  startSimulation,
  stepSimulation,
  rewindSimulation,
  jumpSimulation,
  resetSimulation,
  setSimulationStrategy,
  generateStrategy,
  getSessionPerformance,
} from '../api/backend.js'

/** Formatters kept together so every performance tile renders the same way. */
const fmt = {
  usd: (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
  signedUsd: (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
  pct: (v) => `${v.toFixed(2)}%`,
  signedPct: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`,
  ratio: (v) => v.toFixed(2),
  // Metrics that are genuinely undefined (no closed trades yet, no losing trades) come
  // back as null and must not be rendered as a confident "0.00".
  orDash: (v, format) => (v == null ? '—' : format(v)),
}

const DEFAULT_STRATEGY = { kind: 'sma_crossover', params: { fastPeriod: 10, slowPeriod: 30 } }
const SPEED_OPTIONS = [
  { label: '2x', ms: 120 },
  { label: '1x', ms: 300 },
  { label: '0.5x', ms: 700 },
]
const INTERVAL_OPTIONS = [
  { label: 'Daily', value: '1d' },
  { label: '1 hour', value: '60m' },
  { label: '30 min', value: '30m' },
  { label: '15 min', value: '15m' },
  { label: '5 min', value: '5m' },
]

function isoDate(d) {
  return d.toISOString().slice(0, 10)
}

function defaultDateRange() {
  const end = new Date()
  const start = new Date()
  start.setMonth(start.getMonth() - 6)
  return { period1: isoDate(start), period2: isoDate(end) }
}

/** Most recent completed trading day (skips weekends — a rough proxy, not a holiday calendar). */
function lastTradingDay() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1)
  return d
}

export default function PaperTrading() {
  const [symbol, setSymbol] = useState('AAPL')
  const [{ period1, period2 }, setRange] = useState(defaultDateRange)
  const [barInterval, setBarInterval] = useState('1d')
  const [strategy, setStrategy] = useState(DEFAULT_STRATEGY)
  const [strategyMeta, setStrategyMeta] = useState(null) // { name, rationale } from AI generation

  const [allBars, setAllBars] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [simState, setSimState] = useState(null)
  const [jumpDate, setJumpDate] = useState('')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(SPEED_OPTIONS[1].ms)

  const [busy, setBusy] = useState(null) // which action is in flight, for button disabling
  const [error, setError] = useState(null)
  const [dataInfo, setDataInfo] = useState(null)
  const [performance, setPerformance] = useState(null)

  const stepInFlight = useRef(false)
  const perfInFlight = useRef(false)

  async function withBusy(key, fn) {
    setBusy(key)
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(err.message || 'Something went wrong')
      return null
    } finally {
      setBusy(null)
    }
  }

  async function handleFetchData(e) {
    e.preventDefault()
    await withBusy('fetch', async () => {
      const result = await fetchMarketData(symbol, period1, period2, barInterval)
      setDataInfo(result)
    })
  }

  /** Pulls one trading day of intraday bars from Yahoo Finance into DuckDB and immediately
   * starts replaying that day's simulation — a quick path to "rerun a day's trading". */
  async function handleReplayDay() {
    const day = lastTradingDay()
    const nextDay = new Date(day)
    nextDay.setDate(nextDay.getDate() + 1)
    const p1 = isoDate(day)
    const p2 = isoDate(nextDay)

    setRange({ period1: p1, period2: p2 })
    setBarInterval('5m')

    await withBusy('replay-day', async () => {
      const fetchResult = await fetchMarketData(symbol, p1, p2, '5m')
      setDataInfo(fetchResult)
      const [barsRes, simRes] = await Promise.all([
        getBars(symbol, { start: p1, end: p2 }),
        startSimulation({ symbol, start: p1, end: p2, strategy }),
      ])
      setAllBars(barsRes.bars)
      setSessionId(simRes.sessionId)
      setSimState(simRes)
      setPlaying(false)
    })
  }

  async function handleGenerateStrategy() {
    await withBusy('generate', async () => {
      const { strategy: generated, attempts } = await generateStrategy(
        symbol,
        `Backtest window ${period1} to ${period2}.`,
      )
      setStrategy({ kind: generated.kind, params: generated.params })
      setStrategyMeta({ name: generated.name, rationale: generated.rationale, attempts })
    })
  }

  async function handleStart() {
    await withBusy('start', async () => {
      const [barsRes, simRes] = await Promise.all([
        getBars(symbol, { start: period1, end: period2 }),
        startSimulation({ symbol, start: period1, end: period2, strategy }),
      ])
      setAllBars(barsRes.bars)
      setSessionId(simRes.sessionId)
      setSimState(simRes)
      setPlaying(false)
    })
  }

  const doStep = useCallback(
    async (n = 1) => {
      if (!sessionId || stepInFlight.current) return
      stepInFlight.current = true
      try {
        const res = await stepSimulation(sessionId, n)
        setSimState(res)
        if (res.isAtEnd) setPlaying(false)
      } catch (err) {
        setError(err.message)
        setPlaying(false)
      } finally {
        stepInFlight.current = false
      }
    },
    [sessionId],
  )

  async function handleRewind(n = 5) {
    await withBusy('rewind', async () => {
      const res = await rewindSimulation(sessionId, n)
      setSimState(res)
    })
  }

  async function handleJump(e) {
    e.preventDefault()
    if (!jumpDate) return
    await withBusy('jump', async () => {
      const res = await jumpSimulation(sessionId, jumpDate)
      setSimState(res)
    })
  }

  async function handleReset() {
    setPlaying(false)
    await withBusy('reset', async () => {
      const res = await resetSimulation(sessionId)
      setSimState(res)
    })
  }

  async function handleApplyStrategy() {
    await withBusy('apply-strategy', async () => {
      const res = await setSimulationStrategy(sessionId, strategy)
      setSimState(res)
    })
  }

  // Auto-step while playing, on the selected speed interval.
  useEffect(() => {
    if (!playing) return undefined
    const id = setInterval(() => doStep(1), speed)
    return () => clearInterval(id)
  }, [playing, speed, doStep])

  const cursor = simState?.cursor
  // Refresh performance whenever the replay position moves. The in-flight guard keeps
  // fast playback from queueing a request per bar, and a failure here is left silent:
  // analytics going stale must not surface as an error over a working simulation.
  useEffect(() => {
    if (!sessionId) {
      setPerformance(null)
      return
    }
    if (perfInFlight.current) return
    let cancelled = false
    perfInFlight.current = true
    getSessionPerformance(sessionId)
      .then((res) => {
        if (!cancelled) setPerformance(res.performance)
      })
      .catch(() => {})
      .finally(() => {
        perfInFlight.current = false
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, cursor])

  const visibleBars = useMemo(() => allBars.slice(0, simState?.cursor ?? 0), [allBars, simState])
  const equityCurve = simState?.equityCurve ?? []
  const trades = simState?.trades ?? []
  const startingCash = 100000
  const currentEquity = equityCurve.at(-1)?.equity ?? startingCash
  const pnl = currentEquity - startingCash

  return (
    <div className="page">
      <div className="page-head">
        <h1>Paper Trading</h1>
        <p className="page-lede">
          Fetches real historical bars into DuckDB, then replays them bar-by-bar so you can
          step, rewind, and jump to any point and resimulate a strategy from there
          (workplan.md §6). Strategies can be authored by hand or proposed by the Groq-backed
          Strategy Generation Agent — the agent only ever proposes indicator parameters,
          never executable code (workplan.md §7).
        </p>
      </div>

      {error && (
        <Card className="error-banner">
          <strong>Error:</strong> {error}
        </Card>
      )}

      <Card title="1. Load Market Data" subtitle="Fetches from Yahoo Finance and caches into DuckDB">
        <form className="inline-form" onSubmit={handleFetchData}>
          <label>
            Symbol
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="AAPL" />
          </label>
          <label>
            From
            <input
              type="date"
              value={period1}
              onChange={(e) => setRange((r) => ({ ...r, period1: e.target.value }))}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={period2}
              onChange={(e) => setRange((r) => ({ ...r, period2: e.target.value }))}
            />
          </label>
          <label>
            Bar size
            <select value={barInterval} onChange={(e) => setBarInterval(e.target.value)} aria-label="Bar interval">
              {INTERVAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={busy === 'fetch'}>
            {busy === 'fetch' ? 'Fetching…' : 'Fetch Data'}
          </button>
          <button type="button" onClick={handleReplayDay} disabled={busy === 'replay-day'} className="ai-button">
            {busy === 'replay-day' ? 'Loading day…' : '⏵ Replay Last Trading Day'}
          </button>
        </form>
        {dataInfo && (
          <p className="form-note">
            Stored {dataInfo.storedBars} bars for {dataInfo.symbol}.
          </p>
        )}
      </Card>

      <Card title="2. Choose a Strategy">
        <div className="strategy-form">
          <label>
            Kind
            <select
              value={strategy.kind}
              onChange={(e) =>
                setStrategy(
                  e.target.value === 'sma_crossover'
                    ? { kind: 'sma_crossover', params: { fastPeriod: 10, slowPeriod: 30 } }
                    : { kind: 'rsi_threshold', params: { period: 14, oversold: 30, overbought: 70 } },
                )
              }
            >
              <option value="sma_crossover">SMA Crossover</option>
              <option value="rsi_threshold">RSI Threshold</option>
            </select>
          </label>

          {strategy.kind === 'sma_crossover' ? (
            <>
              <label>
                Fast period
                <input
                  type="number"
                  min="2"
                  value={strategy.params.fastPeriod}
                  onChange={(e) =>
                    setStrategy((s) => ({ ...s, params: { ...s.params, fastPeriod: Number(e.target.value) } }))
                  }
                />
              </label>
              <label>
                Slow period
                <input
                  type="number"
                  min="3"
                  value={strategy.params.slowPeriod}
                  onChange={(e) =>
                    setStrategy((s) => ({ ...s, params: { ...s.params, slowPeriod: Number(e.target.value) } }))
                  }
                />
              </label>
            </>
          ) : (
            <>
              <label>
                RSI period
                <input
                  type="number"
                  min="2"
                  value={strategy.params.period}
                  onChange={(e) =>
                    setStrategy((s) => ({ ...s, params: { ...s.params, period: Number(e.target.value) } }))
                  }
                />
              </label>
              <label>
                Oversold
                <input
                  type="number"
                  value={strategy.params.oversold}
                  onChange={(e) =>
                    setStrategy((s) => ({ ...s, params: { ...s.params, oversold: Number(e.target.value) } }))
                  }
                />
              </label>
              <label>
                Overbought
                <input
                  type="number"
                  value={strategy.params.overbought}
                  onChange={(e) =>
                    setStrategy((s) => ({ ...s, params: { ...s.params, overbought: Number(e.target.value) } }))
                  }
                />
              </label>
            </>
          )}

          <button type="button" onClick={handleGenerateStrategy} disabled={busy === 'generate'} className="ai-button">
            {busy === 'generate' ? 'Asking AI…' : '✦ Generate with AI'}
          </button>
        </div>
        {strategyMeta && (
          <div className="ai-draft-box">
            <span className="ai-draft-label">AI draft — {strategyMeta.name}</span>
            {strategyMeta.rationale}
          </div>
        )}
      </Card>

      <Card title="3. Simulate">
        <div className="sim-controls">
          <button type="button" onClick={handleStart} disabled={busy === 'start'}>
            {busy === 'start' ? 'Starting…' : sessionId ? 'Restart Simulation' : 'Start Simulation'}
          </button>

          {sessionId && (
            <>
              <button type="button" onClick={() => setPlaying((p) => !p)} disabled={simState?.isAtEnd && !playing}>
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button type="button" onClick={() => doStep(1)} disabled={simState?.isAtEnd}>
                ⏭ Step
              </button>
              <button type="button" onClick={() => handleRewind(5)} disabled={busy === 'rewind'}>
                ⏮ Rewind 5
              </button>
              <button type="button" onClick={handleReset} disabled={busy === 'reset'}>
                ↺ Reset
              </button>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
                {SPEED_OPTIONS.map((o) => (
                  <option key={o.ms} value={o.ms}>
                    {o.label}
                  </option>
                ))}
              </select>
              <form className="inline-form" onSubmit={handleJump}>
                <input
                  type="date"
                  value={jumpDate}
                  onChange={(e) => setJumpDate(e.target.value)}
                  aria-label="Jump to date"
                />
                <button type="submit" disabled={busy === 'jump'}>
                  Jump &amp; Resimulate
                </button>
              </form>
              <button type="button" onClick={handleApplyStrategy} disabled={busy === 'apply-strategy'}>
                Apply Strategy Change
              </button>
            </>
          )}
        </div>

        {simState && (
          <>
            <div className="stat-grid sim-stats">
              <StatTile label="Bar" value={`${simState.cursor} / ${simState.length}`} />
              <StatTile label="Cash" value={`$${simState.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
              <StatTile label="Position" value={simState.position} />
              <StatTile
                label="Equity vs Start"
                value={`${pnl >= 0 ? '+' : ''}$${pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                deltaTone={pnl >= 0 ? 'tone-good' : 'tone-bad'}
              />
            </div>

            <h2 className="chart-subhead">Price ({symbol}) with trades</h2>
            <LineSeriesChart
              data={visibleBars}
              xKey="ts"
              yKey="close"
              color="var(--series-1)"
              markers={trades}
              emptyLabel="Press Play or Step to reveal bars."
            />

            <h2 className="chart-subhead">Equity Curve</h2>
            <LineSeriesChart
              data={equityCurve}
              xKey="ts"
              yKey="equity"
              color="var(--series-3)"
              formatY={(v) => `$${Math.round(v).toLocaleString()}`}
              emptyLabel="No equity history yet."
            />

            <h2 className="chart-subhead">Trades ({trades.length})</h2>
            {trades.length === 0 ? (
              <p className="empty-state">No trades triggered yet.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Side</th>
                    <th>Qty</th>
                    <th>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {trades
                    .slice()
                    .reverse()
                    .map((t, i) => (
                      <tr key={i}>
                        <td>{new Date(t.ts).toLocaleDateString()}</td>
                        <td>
                          <Badge status={t.side === 'BUY' ? 'healthy' : 'alert'}>{t.side}</Badge>
                        </td>
                        <td>{t.qty}</td>
                        <td>{t.price.toFixed(2)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Card>

      {performance && performance.barsElapsed > 0 && (
        <Card
          title="4. Performance & Monitoring"
          subtitle="Computed deterministically from the equity curve and trade tape — the same numbers Prometheus exports to Grafana"
        >
          <div className="stat-grid">
            <StatTile
              label="Total P&L"
              value={fmt.signedUsd(performance.totalPnl)}
              delta={fmt.signedPct(performance.totalReturnPct)}
              deltaTone={performance.totalPnl >= 0 ? 'tone-good' : 'tone-bad'}
            />
            <StatTile
              label="Max Drawdown"
              value={fmt.pct(performance.maxDrawdownPct)}
              delta={`now ${fmt.pct(performance.currentDrawdownPct)}`}
              deltaTone={performance.currentDrawdownPct > 0 ? 'tone-warn' : 'tone-good'}
            />
            <StatTile
              label="Sharpe"
              value={fmt.ratio(performance.sharpe)}
              delta={`Sortino ${fmt.ratio(performance.sortino)}`}
            />
            <StatTile
              label="Volatility"
              value={fmt.pct(performance.volatilityPct)}
              delta="annualized"
            />
          </div>

          <div className="stat-grid">
            <StatTile
              label="Win Rate"
              value={fmt.orDash(performance.winRatePct, fmt.pct)}
              delta={`${performance.winCount}W / ${performance.lossCount}L`}
            />
            <StatTile
              label="Profit Factor"
              value={fmt.orDash(performance.profitFactor, fmt.ratio)}
              delta={`${performance.roundTripCount} round trips`}
            />
            <StatTile
              label="Exposure"
              value={fmt.pct(performance.exposurePct)}
              delta="of bars in market"
            />
            <StatTile
              label="Best / Worst Trade"
              value={`${fmt.orDash(performance.bestTradePct, fmt.signedPct)} / ${fmt.orDash(
                performance.worstTradePct,
                fmt.signedPct,
              )}`}
            />
          </div>

          <h2 className="chart-subhead">Cumulative P&amp;L</h2>
          <LineSeriesChart
            data={performance.pnlCurve}
            xKey="ts"
            yKey="pnl"
            color={performance.totalPnl >= 0 ? 'var(--good)' : 'var(--bad)'}
            formatY={(v) => fmt.signedUsd(v)}
            referenceValue={0}
            markers={trades}
            emptyLabel="No P&L history yet."
          />

          <h2 className="chart-subhead">Drawdown from Peak</h2>
          <LineSeriesChart
            data={performance.drawdownCurve}
            xKey="ts"
            yKey="drawdown"
            color="var(--bad)"
            formatY={(v) => `${v.toFixed(1)}%`}
            referenceValue={0}
            emptyLabel="No drawdown history yet."
          />
        </Card>
      )}
    </div>
  )
}
