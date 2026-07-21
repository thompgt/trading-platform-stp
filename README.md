# trading-platform-stp

A design exercise and scaffold for a multi-agent, gen-AI-assisted straight-through
processing (STP) trading platform covering order execution, portfolio management,
reporting & charting, technical analytics, and paper trading.

- **[workplan.md](./workplan.md)** — full architecture and design document: the agent
  roster, trade lifecycle / settlement / risk & compliance workflows, AWS + DevOps
  platform, and phased build roadmap.
- **[frontend/](./frontend)** — Vite + React (JavaScript) dashboard UI, currently backed
  by mock data matching the shapes described in the workplan, with navigation across all
  major feature areas (dashboard, order blotter, portfolio, risk & compliance, reporting,
  technical analytics, paper trading, agent activity).

## Running the frontend

```
cd frontend
npm install
npm run dev
```

## Testing

```
cd frontend
npm run test        # run once
npm run test:watch  # watch mode
```

Tests use Vitest + React Testing Library. Every page-level route is wrapped in an
`ErrorBoundary` (`frontend/src/components/ErrorBoundary.jsx`), keyed by path, so a crash
in one page doesn't take down navigation to the rest of the app; chart/report logic that
divides by aggregate values (e.g. the exposure chart) is guarded against empty-data and
divide-by-zero cases rather than assuming mock data is always present.

## Status

Early scaffold stage — see `workplan.md` §10 for the phased roadmap. The frontend is
currently a static, mock-data-driven UI validating navigation/UX ahead of any backend or
agent implementation work.
