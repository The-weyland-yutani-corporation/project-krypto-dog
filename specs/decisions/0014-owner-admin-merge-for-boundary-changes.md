# 0014 -- Owner admin merge is the boundary-change authority gate

- **Status:** Accepted
- **Date:** 2026-10-01
- **Deciders:** @VeVarunSharma

## Context

ADR 0013 established that `risk:boundary` changes are never auto-repaired or
auto-merged and require a human decision. The first implementation represented
that decision with a separate synthetic `Human boundary approval` check in
addition to the required `Agentic merge policy` check.

That duplicated authority state across two synthetic checks. Both checks could
remain visibly running when the state was actually a durable human hold, and a
review-based success transition risked making a boundary pull request look
eligible for auto-merge. GitHub also prohibits a pull-request author from
approving their own change, which made the extra check unusable when the
repository owner was the only eligible maintainer.

The repository already has one deterministic required aggregator,
`Agentic merge policy`. Repository administrators are not bound by required
status checks, so an explicit owner admin merge can record the human boundary
decision without introducing another synthetic approval lifecycle.

## Decision

For same-repository `risk:boundary` pull requests:

- all current-head baseline, QA, and path-selected specialist checks still run;
- `Agentic merge policy` never reports `success`, even when every automated
  check passes or a trusted human submits an approving review;
- once automated checks pass, `Agentic merge policy` completes with
  `action_required` and the summary
  `Owner admin merge required for boundary PR`;
- auto-repair and auto-merge remain disabled;
- only an explicit admin merge performed by the repository owner may merge the
  pull request;
- automation must not perform, proxy, or emulate the admin merge.

The reconciler no longer creates `Human boundary approval` checks. It retains
that check name only to complete historical active instances with `cancelled`
on open, superseded, closed, or merged heads.

Forked pull requests remain governed by their distinct current-head trusted
human approval requirement. Human change requests and blocking labels remain
fail-closed vetoes for every risk tier.

## Consequences

- **Positive:** One deterministic policy check communicates all automated
  merge state; boundary authority is not duplicated across synthetic checks.
- **Positive:** Boundary pull requests cannot accidentally become auto-merge
  eligible after a review approval.
- **Positive:** The owner's merge identity is recorded by GitHub as the
  explicit human boundary decision.
- **Positive:** Durable human intervention is terminal `action_required`, not
  a misleading indefinitely running check.
- **Negative:** Every boundary change requires the repository owner to use an
  admin merge after reviewing the automated evidence.
- **Negative:** Branch protection must continue allowing repository
  administrators to perform that explicit override.

## Alternatives considered

- **Keep the separate `Human boundary approval` check:** rejected because it
  duplicates state, creates stale-check lifecycle problems, and cannot be
  satisfied by a sole maintainer who authored the pull request.
- **Let a trusted approval turn `Agentic merge policy` green:** rejected because
  a passing required policy check could arm auto-merge for boundary work.
- **Allow automation to perform the admin merge:** rejected because it would
  delegate the human-only boundary decision back to the factory.
