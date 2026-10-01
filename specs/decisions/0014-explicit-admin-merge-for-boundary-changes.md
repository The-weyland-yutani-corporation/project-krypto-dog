# 0014 -- Explicit admin merge is the boundary-change authority gate

- **Status:** Accepted
- **Date:** 2026-10-01
- **Deciders:** @VeVarunSharma

## Context

ADR 0013 established that `risk:boundary` changes are never auto-repaired or
auto-merged and require a human decision. The first implementation represented
merge authority with synthetic `Agentic merge policy` and
`Human boundary approval` checks.

Those checks duplicated state already visible in current-head CI, specialist
reviews, labels, and GitHub's merge actor. They could remain visibly running
after the durable decision was already known and repeatedly blocked unrelated
pull requests. The repository does not need a synthetic aggregator to preserve
the boundary: an authorized repository administrator's explicit merge records
the human decision directly.

## Decision

For same-repository `risk:boundary` pull requests:

- all current-head baseline, QA, and path-selected specialist checks still run;
- no synthetic merge-policy or boundary-approval check is created;
- auto-repair and auto-merge remain disabled;
- only an explicit merge performed by an authorized repository administrator
  may merge the pull request;
- automation must not perform, proxy, or emulate the admin merge.

Historical synthetic checks may remain visible on older commits, but repository
automation no longer creates, updates, or backfills them.

Forked pull requests remain governed by their distinct current-head trusted
human approval requirement. Human change requests and blocking labels remain
fail-closed vetoes for every risk tier.

## Consequences

- **Positive:** Boundary authority is not duplicated across synthetic checks.
- **Positive:** Boundary pull requests cannot accidentally become auto-merge
  eligible after a review approval.
- **Positive:** The administrator's merge identity is recorded by GitHub as the
  explicit human boundary decision.
- **Positive:** Durable human intervention is represented by GitHub's merge
  actor rather than a misleading indefinitely running check.
- **Negative:** Every boundary change requires an authorized repository
  administrator to merge explicitly after reviewing the automated evidence.
- **Negative:** Branch protection must continue allowing repository
  administrators to perform that explicit override.

## Alternatives considered

- **Keep the separate `Human boundary approval` check:** rejected because it
  duplicates state, creates stale-check lifecycle problems, and cannot be
  satisfied by a sole maintainer who authored the pull request.
- **Keep `Agentic merge policy` as an aggregator:** rejected because the
  synthetic lifecycle repeatedly blocked pull requests and duplicated direct
  current-head evidence.
- **Allow automation to perform the admin merge:** rejected because it would
  delegate the human-only boundary decision back to the factory.
