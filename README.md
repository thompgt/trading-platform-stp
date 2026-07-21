# trading-platform-stp

A design exercise and working scaffold for a multi-agent, gen-AI-assisted straight-through
processing (STP) trading platform covering order execution, portfolio management,
reporting & charting, technical analytics, and paper trading.

- **[workplan.md](./workplan.md)** — full architecture and design document: the agent
  roster, trade lifecycle / settlement / risk & compliance workflows, AWS + DevOps
  platform, and phased build roadmap.
- **[backend/](./backend)** — Node.js/Express API: fetches historical market data from
  Yahoo Finance and caches it in DuckDB, replays it bar-by-bar for paper trading (step,
  rewind, jump-to-date/resimulate), and runs two Groq-backed agents (strategy generation,
  research copilot) that only ever return schema-validated output.
- **[frontend/](./frontend)** — Vite + React (JavaScript) dashboard UI with navigation
  across all major feature areas (dashboard, order blotter, portfolio, risk & compliance,
  reporting, technical analytics, paper trading, agent activity). Paper Trading and the
  Reporting copilot/allocation chart are wired to the real backend; the rest of the UI is
  still backed by mock data matching the shapes described in the workplan.

## Running it

Two servers, in separate terminals:

```
cd backend
cp .env.example .env   # then put your GROQ_API_KEY in .env — never commit this file
npm install
npm run dev             # http://localhost:4000
```

```
cd frontend
npm install
npm run dev              # http://localhost:5173 (or next free port)
```

The sidebar shows a live "Backend online/offline" indicator so it's obvious when the
backend isn't running. Paper Trading needs the backend; the rest of the dashboard works
(against mock data) even if it's down.

## Testing

Both projects use Vitest:

```
cd backend && npm test     # DuckDB storage, simulation engine, and LLM-agent tests
                            # (LLM tests use a mocked Groq client — no API key needed to run them)
cd frontend && npm run test        # run once
cd frontend && npm run test:watch  # watch mode
```

Backend tests cover: DuckDB bar storage/round-trip, the deterministic replay engine
(step/rewind/jump-to-date, including resimulating a strategy from a rewound point), and
the Groq agents — including that malformed/invalid LLM JSON is retried and, if it never
resolves, surfaced as a typed `LlmValidationError` rather than silently passed downstream.
`backend/src/agents/strategyAgent.js` and `copilotAgent.js` both validate model output
against a `zod` schema before it's ever used.

Frontend tests cover UI components, the error boundary's catch/recover behavior, chart
components (including empty-data and divide-by-zero guards), and the API client's handling
of network failures and non-2xx responses. Every page-level route is wrapped in an
`ErrorBoundary` (`frontend/src/components/ErrorBoundary.jsx`), keyed by path, so a crash on
one page doesn't take down navigation to the rest of the app.

## Status

See `workplan.md` §10 for the phased roadmap. Paper trading (market data ingestion,
DuckDB storage, bar-by-bar replay/resimulation, and the two Groq agents) is functional
end-to-end; most other pages are still mock-data-driven UI ahead of the corresponding
backend agent work.
