# 0008 -- Current-head agent checks authorize same-repository merges

- **Status:** Accepted
- **Date:** 2026-08-09
- **Deciders:** @VeVarunSharma

## Context

Project Krypto's deterministic merge reconciler allows a same-repository pull
request to pass `Agentic merge policy` after the current head passes `Agentic
code review` and every specialist check selected from changed paths. Several
factory instructions instead described the low-risk documentation self-heal
allowlist as the only path that did not require a current human approval.

That disagreement made the repository unsafe as an agent system of record:
different agents could infer different authorization requirements from nearby
instructions even though the executable reconciler had one consistent policy.

## Decision

For same-repository pull requests, current-head agent checks authorize merge:

- every pull request requires a successful `Agentic code review`;
- security-sensitive paths also require a successful `Security review`;
- trading, guardrail, agent, backtest, database, migration, and trading-RFC
  paths also require a successful `Trading safety review`;
- a current trusted human change request or blocking review label keeps the
  merge policy pending;
- forked pull requests require a current trusted human approval.

The low-risk non-sensitive `docs/**` allowlist is a self-heal boundary, not the
general merge-authorization boundary. It controls which enrolled agent pull
requests may receive repair commits after a failed check.

Passing merge checks does not delegate operational or product authority.
Humans retain control over production deployment, live-trading enablement,
secrets and external accounts, and accepting architecture decisions.

## Consequences

- Positive: Repository instructions now match the executable reconciler and its
  current-head contract tests.
- Positive: High-risk paths receive deterministic specialist routing without a
  blanket, unconditional review count.
- Positive: Human change requests, blocking labels, forks, and operational
  production/live decisions remain fail-closed.
- Negative: The quality of same-repository merge authorization depends on the
  specialist path classifier and agent checks, so their policy data, tests, and
  observability must not drift.
- Follow-up: Move policy data into a validated machine-readable artifact loaded
  from the trusted default branch and enforce source/instruction consistency in
  CI.

## Alternatives considered

- **Require a human approval for every non-doc change:** rejected because it
  contradicts the established reconciler behavior and prevents the intended
  current-head specialist-check model.
- **Treat the low-risk docs allowlist as the general merge boundary:** rejected
  because that allowlist exists to constrain repair commits, not to classify all
  mergeable changes.
- **Leave prose and executable policy inconsistent:** rejected because agents
  need one repository-local, auditable source of truth.
