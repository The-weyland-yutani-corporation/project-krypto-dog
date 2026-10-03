# Agentic software factory

Project Krypto runs a safety-bounded, event-driven GitHub factory. The normative contract is [`specs/factory.md`](../specs/factory.md); machine policy is [`.github/agentic-policy.json`](../.github/agentic-policy.json).

- Humans approve goals, boundary merges, production/live actions, secrets/accounts, and architecture.
- Automation may triage, plan, implement, review, repair within caps, natively auto-merge eligible routine/sensitive PRs, and deploy the exact merged SHA to development/shadow.
- Missing authority, ambiguous risk/scope, stale checks, human veto, exhausted repair, or safety impact fails closed.
- Labels are lifecycle state; claims are owned expiring leases; all merge evidence must match the current head.
- See [`agentic-workflows-map.md`](./agentic-workflows-map.md) for the generated workflow inventory.
