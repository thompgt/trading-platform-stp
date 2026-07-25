import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import SystemHealth from './SystemHealth.jsx'
import * as backend from '../api/backend.js'

vi.mock('../api/backend.js')

function summary(overrides = {}) {
  return {
    collectedAt: '2026-07-25T12:00:00.000Z',
    process: {
      uptimeSeconds: 3725,
      startedAt: '2026-07-25T11:00:00.000Z',
      nodeVersion: 'v22.18.0',
      residentMemoryMb: 118.4,
      heapUsedMb: 42.75,
      cpuSecondsTotal: 6.2,
      eventLoopLagMs: 1.23,
      activeHandles: 5,
    },
    http: {
      totalRequests: 420,
      errorRequests: 3,
      errorRatePct: 0.714,
      avgLatencyMs: 12.5,
      inFlight: 1,
      byRoute: [
        { route: '/api/simulation/:id/step', count: 300 },
        { route: '/api/health', count: 120 },
      ],
    },
    llm: {
      totalCalls: 9,
      byOutcome: { success: 7, validation_failed: 1, error: 1 },
      byAgent: { strategy_generation: 5, research_copilot: 4 },
      avgLatencyMs: 850,
      validationRetries: 4,
    },
    data: { barsIngested: 1250, avgFetchMs: 640, avgQueryMs: 0.42 },
    simulation: { activeSessions: 2, sessionsStarted: 3, actions: { step: 300, rewind: 4 } },
    oversight: { riskAlerts: 5, riskBySeverity: { high: 2, medium: 3 }, complianceDrafts: 1 },
    sessions: [
      {
        symbol: 'AAPL',
        equity: 122157,
        pnl: 22157,
        returnPct: 22.157,
        drawdownPct: 1.5,
        maxDrawdownPct: 6.42,
        exposurePct: 61.3,
        sharpe: 1.87,
        trades: 3,
      },
    ],
    ...overrides,
  }
}

/** Value text of a stat tile, located via its label. */
function tileValue(label) {
  return screen.getByText(label).closest('.stat-tile')?.querySelector('.stat-tile-value')?.textContent
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SystemHealth page', () => {
  it('renders service, agent, and oversight metrics from the summary endpoint', async () => {
    backend.getMetricsSummary.mockResolvedValue(summary())
    render(<SystemHealth />)

    expect(await screen.findByText('Uptime')).toBeInTheDocument()
    expect(tileValue('Uptime')).toBe('1h 2m')
    expect(tileValue('Requests Served')).toBe('420')
    expect(tileValue('Error Rate')).toBe('0.71%')
    expect(tileValue('Avg Latency')).toBe('12.5 ms')
    expect(tileValue('Resident Memory')).toBe('118.4 MB')
    expect(tileValue('Event-Loop Lag')).toBe('1.23 ms')
    expect(tileValue('Active Sessions')).toBe('2')
    expect(tileValue('Bars Ingested')).toBe('1,250')
    expect(tileValue('Agent Calls')).toBe('9')
    expect(tileValue('Avg Agent Latency')).toBe('850 ms')
    expect(tileValue('Schema Retries')).toBe('4')
    // validation_failed + error, counted together as "failed".
    expect(tileValue('Failed Calls')).toBe('2')
    expect(tileValue('Risk Alerts')).toBe('5')
    expect(tileValue('Compliance Drafts')).toBe('1')
  })

  it('lists traffic by matched route pattern', async () => {
    backend.getMetricsSummary.mockResolvedValue(summary())
    render(<SystemHealth />)

    expect(await screen.findByText('/api/simulation/:id/step')).toBeInTheDocument()
    expect(screen.getByText('/api/health')).toBeInTheDocument()
  })

  it('shows live replay sessions with signed P&L', async () => {
    backend.getMetricsSummary.mockResolvedValue(summary())
    render(<SystemHealth />)

    expect(await screen.findByText('AAPL')).toBeInTheDocument()
    expect(screen.getByText('+$22,157')).toBeInTheDocument()
    expect(screen.getByText('22.16%')).toBeInTheDocument()
    expect(screen.getByText('1.87')).toBeInTheDocument()
  })

  it('renders a losing session with a leading minus', async () => {
    backend.getMetricsSummary.mockResolvedValue(
      summary({
        sessions: [
          {
            symbol: 'MSFT',
            equity: 94000,
            pnl: -6000,
            returnPct: -6,
            drawdownPct: 7.2,
            maxDrawdownPct: 9.1,
            exposurePct: 40,
            sharpe: -0.5,
            trades: 2,
          },
        ],
      }),
    )
    render(<SystemHealth />)

    expect(await screen.findByText('-$6,000')).toBeInTheDocument()
    expect(screen.getByText('-6.00%')).toBeInTheDocument()
  })

  it('prompts to start a session when none are running', async () => {
    backend.getMetricsSummary.mockResolvedValue(summary({ sessions: [] }))
    render(<SystemHealth />)

    expect(await screen.findByText(/No replay sessions running/)).toBeInTheDocument()
  })

  it('links out to the Grafana dashboard', async () => {
    backend.getMetricsSummary.mockResolvedValue(summary())
    render(<SystemHealth />)

    const link = await screen.findByRole('link', { name: /Grafana dashboard/ })
    expect(link).toHaveAttribute('href', expect.stringContaining('/d/stp-platform'))
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('surfaces an error when the metrics endpoint is unreachable', async () => {
    backend.getMetricsSummary.mockRejectedValue(new Error('Could not reach the backend'))
    render(<SystemHealth />)

    expect(await screen.findByText(/Metrics unavailable/)).toBeInTheDocument()
    expect(screen.getByText(/Could not reach the backend/)).toBeInTheDocument()
  })

  it('keeps the last good reading on screen when a later refresh fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    backend.getMetricsSummary.mockResolvedValueOnce(summary())
    render(<SystemHealth />)

    expect(await screen.findByText('Uptime')).toBeInTheDocument()

    backend.getMetricsSummary.mockRejectedValue(new Error('backend went away'))
    await vi.advanceTimersByTimeAsync(5000)

    await waitFor(() => expect(screen.getByText(/Metrics unavailable/)).toBeInTheDocument())
    // Stale data is still shown, explicitly labelled as such.
    expect(screen.getByText(/showing the last successful reading/)).toBeInTheDocument()
    expect(tileValue('Requests Served')).toBe('420')
  })

  it('polls for fresh metrics on an interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    backend.getMetricsSummary.mockResolvedValue(summary())
    render(<SystemHealth />)

    await waitFor(() => expect(backend.getMetricsSummary).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(5000)
    await waitFor(() => expect(backend.getMetricsSummary).toHaveBeenCalledTimes(2))
  })
})
