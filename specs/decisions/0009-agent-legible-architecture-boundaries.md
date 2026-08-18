# 0009 -- Agent-legible architecture boundaries

- **Status:** Accepted
- **Date:** 2026-08-09
- **Deciders:** @VeVarunSharma

## Context

Project Krypto already separates the read-only model proposal, deterministic
authorization, transactional paper execution, persistence, and operator UI.
Those boundaries are described in specs and tests, but several are not visible
to an agent until review. Agent-generated code tends to repeat nearby imports,
so a single accidental dependency can become a copied pattern.

The existing architecture is not the generic layer stack from another project.
`src/agent/run-flow.ts` intentionally composes persistence, model decisions,
policy, telemetry, and the paper executor. Server-rendered admin pages may read
from the database. The valuable constraints are narrower.

## Decision

Enforce these dependency boundaries with ESLint and focused structural tests:

1. `src/agent/decision.ts` and `src/agent/llm.ts` remain read-only and may not
   import paper execution.
2. `src/trading/**` remains deterministic and may not import `src/agent/**` or
   LangChain/model packages.
3. Shared UI components and admin `_components` may not import the database
   implementation; server components and API routes remain explicit boundaries.
4. v2 contains no live executor. A live path requires a separate accepted RFC,
   release plan, security review, trading-safety review, and human enablement.

Lint failures include the safe remediation so future agent runs receive the
boundary and the intended alternative in context.

## Consequences

- Positive: The highest-value safety boundaries fail during local lint and CI,
  before review or runtime.
- Positive: `run-flow.ts` remains an explicit composition root rather than
  forcing an artificial abstraction across every layer.
- Positive: Server-rendered pages can keep performing typed database reads while
  client/shared components stay persistence-agnostic.
- Negative: New legitimate boundary exceptions require an architecture decision
  or a narrowly reviewed ESLint override.
- Follow-up: The report-only entropy scanner may surface boundary hotspots, but
  it must not rewrite them automatically.

## Alternatives considered

- **Adopt a generic fixed layer stack:** rejected because it does not match the
  existing Next.js, Drizzle, and orchestration architecture.
- **Rely on review prompts only:** rejected because prose does not stop agents
  from copying an unsafe import.
- **Ban all database imports from `src/app/**`:** rejected because server
  components and API routes are intentional persistence boundaries.
