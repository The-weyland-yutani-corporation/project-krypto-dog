# Backlog governance

The standing mission and numeric limits are canonical in
[`agentic-policy.json`](agentic-policy.json), under `autonomy`.
See [`specs/factory.md`](../specs/factory.md) for the execution contract.

## Standing authorization

The queue controller creates one bot-owned `factory:autonomous-goal` from
repository policy. Its body, milestone, and scope must match that policy
exactly. The legacy `factory:goal-approved` label is retained for compatibility;
it is not a per-batch human approval.

Discovery, triage, approach review and planning produce bounded, goal-owned
issues. Human approval is not required for each idea, ticket, or same-repository
boundary PR. Risk selects automated verification, never fewer checks.

## Queue readiness

Each implementation issue needs one direct native goal parent, complete
acceptance criteria, exact allowed paths, one risk tier, dependencies,
validation commands, and a rollback/safe-reversal statement. Planning uses
the headings in [`agentic-work-item.yml`](ISSUE_TEMPLATE/agentic-work-item.yml).

WIP counts work already in progress. Assignment budget counts actual claim
records in the current UTC day and resets without human renewal. Missing
timestamps count conservatively. The opportunity ceiling applies to the
standing mission's actionable opportunity backlog, not unrelated legacy issues.

## Handoffs and failures

The queue's serialized intake pass explicitly dispatches bot-written state
transitions. It limits daily discovery and stage retries and checks outstanding
runs across day boundaries. Removed slash aliases are replaced by controlled
workflow dispatch; bot comments cannot recursively issue those commands.

Failed or ambiguous work stays visibly blocked. The factory must not invent
evidence, duplicate an implementation, silently adopt legacy work, clear an
emergency pause, or delete tests to keep throughput green.

Product and trading behavior remain defined by
[`specs/product.md`](../specs/product.md). Software-delivery authorization does
not authorize financial transactions or weaken application accounting.
