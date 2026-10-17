# Copilot instructions for Project Krypto


## Read the shared instructions first

This is a thin platform shim. Copilot does not reliably auto-load nested
`AGENTS.md`, so **explicitly** read the shared map and the scoped file for your
area before editing:

- Root map, task router, merge policy, and stop conditions:
  [`../AGENTS.md`](../AGENTS.md).
- Scoped deltas: [`../src/agent/AGENTS.md`](../src/agent/AGENTS.md),
  [`../src/trading/AGENTS.md`](../src/trading/AGENTS.md),
  [`../src/db/AGENTS.md`](../src/db/AGENTS.md), and
  [`workflows/AGENTS.md`](./workflows/AGENTS.md).
- Canonical policy data: [`agentic-policy.json`](./agentic-policy.json) — do not
  duplicate its lists.

## Design system

- For any frontend, admin UI, chart, graph, or user-facing copy/layout change,
  read root [`DESIGN.md`](../DESIGN.md) first.
- UI work must use shadcn/ui-style local components plus Tailwind tokens.
- Charts and graphs must use Project Krypto's EvilCharts-inspired Recharts
  components/patterns, not default unstyled Recharts output.
- Keep the visual direction as a dark trading-terminal/operator-console.
- Locked, paused, destructive, and paper-vs-live states must remain explicit.
- If a UI change intentionally deviates from `DESIGN.md`, document why in the
  PR or implementation notes.

Backend-only work does not need design changes unless it changes user-facing
admin output, chart data, page content, or operational messaging.
