# Architecture Decision Records

This directory captures **why** significant architectural choices were made. ADRs are the missing layer between a code change (`git blame` tells you what) and a product spec (`prd.md` tells you what is true today).

## When to write one

Open an ADR for any decision that:

- Locks in a technology choice (DB, ORM, hosting, queue, …)
- Changes how a critical subsystem behaves (auth, money movement, scheduling)
- Was contentious or had >1 reasonable option
- A future contributor would otherwise want to reverse without context

Skip ADRs for routine code changes, refactors, dependency bumps, or anything covered by a PR description.

## Format

Filename: `NNNN-kebab-slug.md` where `NNNN` is the next zero-padded 4-digit number.

```markdown
# NNNN — Title

- **Status:** Proposed | Accepted | Superseded by NNNN | Deprecated
- **Date:** YYYY-MM-DD
- **Deciders:** @handle, @handle

## Context
What problem are we solving? What constraints apply?

## Decision
What did we choose, in one or two paragraphs?

## Consequences
- Positive: …
- Negative / trade-offs: …
- Follow-ups required: …

## Alternatives considered
- Option A — why rejected
- Option B — why rejected
```

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-drizzle-over-prisma.md) | Drizzle ORM over Prisma | Accepted |
| [0002](./0002-paper-trading-before-live.md) | Paper trading before live AgentKit | Accepted |
| [0003](./0003-pg-cron-over-vercel-cron.md) | Supabase pg_cron over Vercel Cron | Superseded by [0008](./0008-azure-native-deployment-architecture.md) |
| [0004](./0004-hybrid-spec-strategy.md) | Hybrid spec strategy (master + ADRs + RFCs + tags) | Accepted |
| [0005](./0005-structured-llm-intent-authorization.md) | Structured LLM intent + hard deterministic authorization | Accepted |
| [0006](./0006-migration-history-supabase-schema.md) | Single Drizzle migration history and private Supabase schema | Proposed |
| [0007](./0007-evidence-based-goals.md) | Evidence-based goals and removal of guaranteed-profit language | Accepted |
| [0008](./0008-agentic-merge-authorization.md) | Current-head agent checks authorize same-repository merges | Accepted |
| [0008](./0008-azure-native-deployment-architecture.md) | Azure-native deployment architecture (Container Apps, Flexible Server, Key Vault, Bicep) — implemented, provisioning pending | Accepted |
| [0009](./0009-agent-legible-architecture-boundaries.md) | Agent-legible architecture boundaries | Accepted |
| [0010](./0010-staged-correction-ops.md) | Staged, report-only CorrectionOps | Accepted |
| [0011](./0011-mock-first-worktree-harness.md) | Mock-first, per-worktree application harness | Accepted |
| [0012](./0012-evidence-gated-automation-authority.md) | Evidence-gated automation authority | Accepted |
| [0013](./0013-autonomous-agentic-sdlc-factory.md) | Safety-bounded autonomous agentic SDLC factory (goal-bound queue controller, tiered risk/repair caps, dev-only auto-deploy) | Accepted |
| [0014](./0014-owner-admin-merge-for-boundary-changes.md) | Owner admin merge is the boundary-change authority gate | Accepted |
