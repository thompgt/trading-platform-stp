// Mock data standing in for real agent/event-bus output until a backend exists.
// Shapes here intentionally mirror the agents/workflows described in workplan.md.

export const agents = [
  { name: 'Order Intake', domain: 'Execution', nature: 'Rules', status: 'healthy' },
  { name: 'Smart Order Router', domain: 'Execution', nature: 'Rules + Quant', status: 'healthy' },
  { name: 'Execution Management', domain: 'Execution', nature: 'Rules', status: 'healthy' },
  { name: 'Allocation', domain: 'Post-trade', nature: 'Rules', status: 'healthy' },
  { name: 'Settlement', domain: 'Post-trade', nature: 'Rules', status: 'warning' },
  { name: 'Reconciliation', domain: 'Post-trade', nature: 'Rules + ML', status: 'healthy' },
  { name: 'Pre-Trade Risk', domain: 'Risk & Compliance', nature: 'Rules (hard gate)', status: 'healthy' },
  { name: 'Market Risk', domain: 'Risk & Compliance', nature: 'Quant', status: 'healthy' },
  { name: 'Compliance Surveillance', domain: 'Risk & Compliance', nature: 'Gen-AI (draft-only)', status: 'alert' },
  { name: 'Regulatory Reporting', domain: 'Risk & Compliance', nature: 'Rules', status: 'healthy' },
  { name: 'Portfolio Management', domain: 'Portfolio & Analytics', nature: 'Rules', status: 'healthy' },
  { name: 'Technical Analytics', domain: 'Portfolio & Analytics', nature: 'Quant', status: 'healthy' },
  { name: 'Reporting & Charting', domain: 'Portfolio & Analytics', nature: 'Gen-AI copilot + Rules', status: 'healthy' },
  { name: 'Paper Trading / Simulation', domain: 'Strategy & Sim', nature: 'Rules', status: 'healthy' },
  { name: 'Strategy Generation', domain: 'Strategy & Sim', nature: 'Gen-AI', status: 'healthy' },
  { name: 'Ops / Incident Response', domain: 'Ops', nature: 'Gen-AI-assisted', status: 'healthy' },
  { name: 'Supervisor / Orchestrator', domain: 'Orchestration', nature: 'Rules + State Machine', status: 'healthy' },
]

export const roadmapPhases = [
  { phase: 0, title: 'Foundations', scope: 'Event bus, IaC baseline, core data model', status: 'complete' },
  { phase: 1, title: 'STP core loop (simulated)', scope: 'Order Intake, Pre-Trade Risk, SOR, Execution Mgmt, Paper Trading', status: 'in-progress' },
  { phase: 2, title: 'Post-trade', scope: 'Allocation, Settlement, Reconciliation, Portfolio Management', status: 'planned' },
  { phase: 3, title: 'Risk & compliance depth', scope: 'Market Risk, Compliance Surveillance, Regulatory Reporting', status: 'planned' },
  { phase: 4, title: 'Analytics & gen-AI surfaces', scope: 'Technical Analytics, Reporting & Charting, Strategy Generation', status: 'planned' },
  { phase: 5, title: 'Hardening', scope: 'DR, chaos testing, security review, scale testing', status: 'planned' },
]

export const orders = [
  { id: 'ORD-10231', symbol: 'AAPL', side: 'BUY', qty: 500, type: 'LIMIT', status: 'FILLED', venue: 'NASDAQ', asset: 'Equity' },
  { id: 'ORD-10232', symbol: 'MSFT', side: 'SELL', qty: 250, type: 'MARKET', status: 'PARTIAL', venue: 'NYSE', asset: 'Equity' },
  { id: 'ORD-10233', symbol: 'SPY 450C', side: 'BUY', qty: 20, type: 'LIMIT', status: 'WORKING', venue: 'CBOE', asset: 'Option' },
  { id: 'ORD-10234', symbol: 'ES FUT', side: 'SELL', qty: 5, type: 'LIMIT', status: 'PENDING RISK', venue: 'CME', asset: 'Future' },
  { id: 'ORD-10235', symbol: 'TSLA', side: 'BUY', qty: 100, type: 'LIMIT', status: 'REJECTED', venue: 'NASDAQ', asset: 'Equity' },
  { id: 'ORD-10236', symbol: 'NVDA', side: 'SELL', qty: 300, type: 'MARKET', status: 'SETTLED', venue: 'NASDAQ', asset: 'Equity' },
]

export const positions = [
  { symbol: 'AAPL', qty: 1500, avgPrice: 189.32, last: 194.10, unrealized: 7170, asset: 'Equity' },
  { symbol: 'MSFT', qty: -250, avgPrice: 412.55, last: 409.80, unrealized: 687.5, asset: 'Equity' },
  { symbol: 'SPY 450C', qty: 20, avgPrice: 6.10, last: 6.85, unrealized: 1500, asset: 'Option' },
  { symbol: 'ES FUT', qty: -5, avgPrice: 5321.25, last: 5308.00, unrealized: 3312.5, asset: 'Future' },
  { symbol: 'NVDA', qty: 800, avgPrice: 118.44, last: 121.02, unrealized: 2064, asset: 'Equity' },
]

export const riskAlerts = [
  { id: 'RSK-501', severity: 'high', agent: 'Market Risk', message: 'ES FUT position exceeds intraday VaR limit by 12%', time: '09:41:03' },
  { id: 'RSK-502', severity: 'medium', agent: 'Pre-Trade Risk', message: 'ORD-10234 held pending margin sufficiency check', time: '09:42:11' },
  { id: 'RSK-503', severity: 'low', agent: 'Market Risk', message: 'SPY 450C Greeks approaching delta limit (0.78 / 0.85)', time: '09:44:57' },
]

export const complianceAlerts = [
  {
    id: 'CMP-118',
    severity: 'high',
    pattern: 'Potential layering pattern',
    symbol: 'TSLA',
    status: 'Pending compliance review',
    aiDraft:
      'Order cluster on TSLA shows 6 cancels within 400ms of touching the inside quote, ' +
      'followed by an opposite-side fill 900ms later. Recommend reviewing trader ID TR-2291 ' +
      'order history for the prior 3 sessions. This is an AI-drafted triage summary — not a filing.',
  },
  {
    id: 'CMP-119',
    severity: 'low',
    pattern: 'Restricted list proximity',
    symbol: 'NVDA',
    status: 'Auto-cleared',
    aiDraft: 'Order flagged only because NVDA appears on a related watch list; no restriction breach found.',
  },
]

export const analyticsSignals = [
  { symbol: 'AAPL', indicator: 'RSI(14)', value: 71.2, signal: 'Overbought', trend: [62, 64, 66, 69, 70, 71.2] },
  { symbol: 'MSFT', indicator: 'MACD', value: -0.42, signal: 'Bearish crossover', trend: [0.3, 0.15, 0.05, -0.1, -0.28, -0.42] },
  { symbol: 'NVDA', indicator: '50/200 SMA', value: 1.08, signal: 'Golden cross', trend: [0.94, 0.97, 1.0, 1.03, 1.06, 1.08] },
  { symbol: 'ES FUT', indicator: 'Bollinger %B', value: 0.94, signal: 'Near upper band', trend: [0.6, 0.68, 0.78, 0.85, 0.9, 0.94] },
]

export const paperStrategies = [
  { name: 'Mean Reversion — SPY 5m', origin: 'Strategy Generation Agent (gen-AI)', pnl: 1284.55, trades: 42, status: 'running' },
  { name: 'Momentum Breakout — Tech basket', origin: 'Manual (quant desk)', pnl: -320.10, trades: 18, status: 'running' },
  { name: 'Covered Call Overlay — NVDA', origin: 'Strategy Generation Agent (gen-AI)', pnl: 512.00, trades: 6, status: 'paused' },
]

export const agentActivityLog = [
  { time: '09:41:05', agent: 'Compliance Surveillance', action: 'Drafted triage summary for CMP-118', kind: 'ai-draft' },
  { time: '09:42:12', agent: 'Pre-Trade Risk', action: 'Held ORD-10234 pending margin check', kind: 'gate' },
  { time: '09:44:59', agent: 'Market Risk', action: 'Raised RSK-503 (Greeks approaching limit)', kind: 'alert' },
  { time: '09:47:20', agent: 'Ops / Incident Response', action: 'Summarized settlement delay on ORD-10231, no action needed', kind: 'ai-draft' },
  { time: '09:50:01', agent: 'Strategy Generation', action: 'Proposed new mean-reversion variant for paper trading', kind: 'ai-draft' },
  { time: '09:52:44', agent: 'Reconciliation', action: 'Matched 214/216 trades against custodian feed; 2 breaks raised', kind: 'info' },
]
