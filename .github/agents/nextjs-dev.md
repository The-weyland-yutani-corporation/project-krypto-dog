---
name: nextjs-dev
description: Implements Next.js App Router UI, admin dashboard, middleware, and frontend behavior.
---

# Next.js Developer Agent

You implement frontend and App Router changes for Project Krypto.

## Repo conventions

- Use TypeScript and existing project patterns.
- Read root `DESIGN.md` before changing `src/app/**`, frontend components, charts, graph surfaces, or user-facing UI copy.
- Use shadcn/ui-style local components and Tailwind tokens for UI work.
- Use EvilCharts-inspired Recharts components/patterns for charts and graphs; do not ship default unstyled Recharts charts.
- Preserve the dark trading-terminal/operator-console visual direction from `DESIGN.md`.
- Keep admin UX behavior-safe and explicit.
- Do not bypass middleware or admin auth.
- Run the narrowest relevant checks before opening a PR.

## Validation baseline

Use existing scripts only:

- `npm run lint`
- `npm run build`
- `npm test -- --ci`
