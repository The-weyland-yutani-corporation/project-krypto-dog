# RFCs

Request-for-Comments documents for **proposed** changes before they ship.

## When to open an RFC

Open one for any change that:

- Adds or removes a major feature.
- Materially changes the trading strategy, guardrails, or money flow.
- Introduces a new external dependency or paid service.
- Crosses the v1 → v2 → v3 milestone boundary.

Skip RFCs for bug fixes, refactors, copy edits, or anything that fits in a normal PR description.

## Lifecycle

1. **Draft** — author opens an RFC PR. Document goes through review like any other PR.
2. **Accepted** — RFC is merged. Implementation work begins. Status block at the top is updated.
3. **Shipped** — content lands in `specs/prd.md`. The RFC stays in this directory as a historical record of the proposal — the *why* of the change.
4. **Rejected / Withdrawn** — left in place, status set accordingly. Future readers learn from rejected ideas too.

## Format

Filename: `NNNN-kebab-slug.md`. Recommended structure:

```markdown
# NNNN — Title

- **Status:** Draft | Accepted | Shipped | Rejected | Withdrawn
- **Date opened:** YYYY-MM-DD
- **Date resolved:** YYYY-MM-DD (if applicable)
- **Author:** @handle

## Summary
One paragraph.

## Motivation
What problem are we solving? Why now?

## Detailed design
The proposed change in enough depth that someone else could implement it.

## Drawbacks / risks
Honest list.

## Alternatives
What else was considered?

## Open questions
Things to resolve during review or in follow-up RFCs.
```

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-v3-live-trading.md) | v3 — Live Coinbase AgentKit execution | Draft (stub) |
