# 0012 -- Evidence-gated automation authority

- **Status:** Accepted
- **Date:** 2026-08-09
- **Deciders:** @VeVarunSharma

## Context

Project Krypto now has deterministic SDLC safety fixtures, MonitorOps, a
report-only entropy loop, and staged CorrectionOps. Those systems create
evidence about agent behavior; they do not authorize more behavior.

Automatically promoting a measurement workflow into a write-capable workflow
would bypass the human judgment the harness is intended to preserve. A future
proposal needs a concrete evidence gate and a separate authority decision.

## Decision

`harness-entropy` and `agentic-corrections` remain report-only in the current
system. Neither may create a pull request, edit a branch, add labels, update
instructions, or change policy.

A future proposal to grant a narrowly defined write capability requires all of:

1. Every critical SDLC safety fixture passes 100%, with a zero forbidden-action
   rate.
2. The candidate behavior has at least three repeated TrialOps runs on the same
   corpus with no safety or quality regression.
3. MonitorOps reports complete workflow/cost coverage for four consecutive
   weekly windows, with no unresolved policy/source-lock drift.
4. CorrectionOps has at least 30 trusted-human-scored decisions for the exact
   workflow/instruction scope, a correction rate no greater than 10%, and no
   unresolved immutable-route conflict.
5. The proposed write is reversible, has a tested rollback, and is limited to an
   explicit file/output allowlist.
6. A human accepts a new ADR that names the new permission, safe output,
   thresholds, rollback, and revocation condition.

The first eligible promotion, if separately approved, is limited to opening a
**draft** pull request for allowlisted non-sensitive documentation. It does not
include automerge. Trading, guardrails, auth, database, migrations, deployment,
secrets, agentic policy, and live-adjacent paths are excluded from this
promotion path.

Failure, missing telemetry, cache loss, a corpus-version change, or insufficient
sample size leaves the workflow report-only. Authority never expands
automatically when a threshold is met.

## Consequences

- Positive: Measurement and authorization remain separate, auditable decisions.
- Positive: A future proposal has objective prerequisites and an explicit
  revocation path rather than an anecdotal "the agent seems reliable" claim.
- Positive: High-risk product and operational surfaces stay outside cleanup and
  instruction-learning write authority.
- Negative: It takes multiple weekly windows and trusted-human decisions before
  even a docs-only draft-PR proposal can be considered.
- Follow-up: No implementation follow-up is authorized by this ADR. A new ADR is
  required if the evidence threshold is later satisfied.

## Alternatives considered

- **Promote automatically when metrics pass:** rejected because metrics inform
  judgment; they do not grant authority.
- **Allow immediate docs automerge:** rejected because the new entropy and
  correction loops have no production precision history yet.
- **Use the same promotion path for high-risk code:** rejected because those
  surfaces require their existing specialist and human operational controls.
