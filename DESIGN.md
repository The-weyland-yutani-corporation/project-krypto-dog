---
version: alpha
name: Project-Krypto-design-system
description: A dark trading-terminal/operator-console interface for Project Krypto: autonomous ETH/USDC paper trading, agent operations, guardrails, journal reasoning, and backtest evidence. The system uses shadcn/ui primitives, Tailwind tokens, and EvilCharts-style Recharts visualizations. It prioritizes safety-state clarity, tabular numeric legibility, and calm high-density monitoring over generic SaaS decoration.

colors:
  canvas: "#05070a"
  canvas-soft: "#080b10"
  panel: "#0d1117"
  panel-elevated: "#111827"
  panel-strong: "#172033"
  border: "#243044"
  border-soft: "#182233"
  ink: "#f8fafc"
  body: "#cbd5e1"
  muted: "#94a3b8"
  muted-soft: "#64748b"
  primary: "#f8fafc"
  primary-foreground: "#05070a"
  secondary: "#111827"
  secondary-foreground: "#e2e8f0"
  success: "#22c55e"
  success-soft: "#052e16"
  warning: "#f59e0b"
  warning-soft: "#451a03"
  error: "#ef4444"
  error-soft: "#450a0a"
  info: "#38bdf8"
  info-soft: "#082f49"
  chart-equity: "#38bdf8"
  chart-profit: "#22c55e"
  chart-loss: "#ef4444"
  chart-benchmark: "#a78bfa"
  chart-grid: "#1e293b"

typography:
  display-xl:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: 56px
    fontWeight: 650
    lineHeight: 1.02
    letterSpacing: -2px
  display-lg:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: 42px
    fontWeight: 650
    lineHeight: 1.08
    letterSpacing: -1.5px
  display-md:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: 32px
    fontWeight: 650
    lineHeight: 1.12
    letterSpacing: -1px
  title-lg:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: 22px
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: -0.3px
  title-md:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: 18px
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: -0.2px
  body-md:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.35
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.5

rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  pill: 9999px

spacing:
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 80px

components:
  app-shell:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
  sidebar:
    backgroundColor: "{colors.panel}"
    borderColor: "{colors.border-soft}"
  panel-card:
    backgroundColor: "{colors.panel}"
    borderColor: "{colors.border}"
    textColor: "{colors.body}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  metric-card:
    backgroundColor: "{colors.panel}"
    borderColor: "{colors.border}"
    textColor: "{colors.body}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: 40px
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
    height: 40px
  button-danger:
    backgroundColor: "{colors.error-soft}"
    textColor: "{colors.error}"
    borderColor: "{colors.error}"
    rounded: "{rounded.md}"
  badge:
    backgroundColor: "{colors.panel-strong}"
    textColor: "{colors.body}"
    borderColor: "{colors.border}"
    rounded: "{rounded.pill}"
  trade-table:
    backgroundColor: "{colors.panel}"
    borderColor: "{colors.border}"
    textColor: "{colors.body}"
  chart-card:
    backgroundColor: "{colors.panel}"
    borderColor: "{colors.border}"
    rounded: "{rounded.lg}"
---

## Overview

Project Krypto is an autonomous paper-trading system. Its interface should feel
like a composed trading operations console: dark, precise, data-dense, and
calm. The UI is not a neon crypto dashboard and not a generic white SaaS page.
It should make the current risk state obvious, make numbers easy to scan, and
turn agent/backtest evidence into product UI artifacts.

Use **shadcn/ui + Tailwind** as the component foundation. shadcn components are
local source components, so they should be adapted to these tokens rather than
treated as a separate visual brand.

Use **EvilCharts-style graphs** for chart surfaces: handcrafted, opinionated,
dark-terminal-compatible Recharts components with intentional grid, tooltip,
color, and annotation choices. Never drop in raw default Recharts styling.

## Visual principles

- Dark canvas first: `{colors.canvas}` and `{colors.panel}` are the default.
- Data before decoration: cards should contain portfolio state, trades, journal
  reasoning, backtest evidence, or guardrail status.
- Safety states are explicit: `locked`, `paused`, `running`, destructive lease
  release, and `disabled`/`shadow`/`paper` modes must be visually unmistakable.
- Numbers use tabular alignment where possible.
- Green/red/amber are semantic, not decorative.
- Cyan/blue is a sparse information/chart accent, not a primary CTA color.
- Avoid low-contrast gray-on-black text.

## Component rules

### shadcn primitives

Use shadcn-style components for buttons, cards, badges, tables, inputs, alerts,
and separators. Prefer composition over ad hoc class strings. If a new page
needs a common primitive, add or adapt a shadcn-style component in
`src/components/ui/`.

### Buttons

- Primary: light text-on-dark inverse button for safe primary actions.
- Secondary: dark panel button with border for neutral operations.
- Warning: amber for pause/resume and operator-attention actions.
- Danger: red/low-saturation destructive control for release-lease flows.
- Do not use blue primary buttons.

### Cards and panels

Cards are dark panels with thin borders. Use elevated cards sparingly for
important summaries. Avoid white admin cards. Landing-page product artifacts can
use layered panels and glow accents, but still follow terminal contrast.

### Tables

Trade and ledger tables should prioritize legibility:

- sticky or distinct header treatment when practical
- muted timestamps
- tabular figures
- semantic BUY/SELL and PnL badges
- no zebra striping unless it improves scanability

### Charts

Charts should use EvilCharts/Recharts patterns:

- dark chart card surface
- subtle grid lines
- clear tooltip with scenario name and values
- cyan/equity, violet/benchmark, green/profit, red/loss
- no default Recharts color palette
- annotate whether the agent beats cash or buy-and-hold

## Required product fragments

Prefer real Project Krypto UI fragments over abstract illustrations:

- portfolio value and balances
- agent run status
- operations panel
- trade ledger row
- journal reasoning excerpt
- backtest scenario report
- equity vs buy-and-hold chart
- drawdown/guardrail banner

## AI and agent usage

All frontend/admin/design-affecting work must:

1. Read root `DESIGN.md` before changing UI.
2. Use shadcn/ui + Tailwind primitives unless there is a clear reason not to.
3. Use EvilCharts-style Recharts components for charts/graphs.
4. Keep safety states visually explicit.
5. Note any design deviation in the PR description or implementation note.

Backend-only changes do not need design changes unless they alter user-facing
output, admin behavior, chart data, or page content.

## Don'ts

- Do not copy Cal.com names, Cal.com product examples, or Cal Sans claims.
- Do not introduce neon crypto gradients as the main brand system.
- Do not make destructive controls look like normal primary actions.
- Do not use default, unstyled Recharts charts.
- Do not create one-off Tailwind styles when an existing shadcn primitive fits.
- Do not hide the permanent paper-only status or selected execution mode.

## Responsive behavior

- Mobile: panels stack, tables scroll horizontally, chart legends collapse or
  wrap, and safety controls remain reachable.
- Tablet: keep two-column cards where readable; charts should preserve labels.
- Desktop: use dense dashboards with clear card hierarchy and chart/table grids.
- Wide: cap content width and avoid stretching tables beyond readable measure.

## Iteration guide

1. Start by picking the documented component or token.
2. Prefer shadcn primitives and Project Krypto composition components.
3. Keep semantic color use consistent.
4. Validate with lint/build and inspect `/`, `/admin/login`, `/admin`,
   `/admin/trades`, and `/admin/journal`.
5. Update `DESIGN.md` if a new reusable visual pattern ships.
