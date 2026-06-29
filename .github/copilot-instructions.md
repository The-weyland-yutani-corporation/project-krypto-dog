# Copilot instructions for Project Krypto

Project Krypto is an autonomous ETH/USDC paper-trading app. Preserve trading
safety first: do not weaken guardrails, mutex behavior, admin auth, journaling,
or paper/live boundaries.

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
