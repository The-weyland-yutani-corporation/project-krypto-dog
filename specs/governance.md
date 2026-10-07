# Governance
- These five files are the complete specification surface; update one in the same PR as behavior and use Git history for detail instead of adding ADR, RFC, archive, or versioned spec files.
- Human-only decisions: production deployment/promotion, live trading/funding/custody, secrets/accounts/access expansion, and architecture acceptance.
- Never weaken paper-only isolation, deterministic authorization, guardrails, reconciliation, leases, idempotency, journaling, admin auth, accounting, or fail-closed factory behavior.
- Accepted direction: Drizzle/private PostgreSQL, Azure-native immutable releases, Container Apps Jobs, structured read-only model proposals, evidence versus cash/buy-and-hold, mock-first isolated tests, and current-head factory evidence.
- Retired spec paths embedded in applied migration comments are historical provenance resolved through Git history; never rewrite migration bytes merely to refresh a documentation link.
- Live execution remains unimplemented and unauthorized; it requires separate accepted architecture, operational/security/legal review, qualifying paper windows, capital/exposure/drawdown/kill-switch controls, and human release approval.
- Machine-readable policy lists remain canonical in `.github/agentic-policy.json`; contradictions resolve to the safer interpretation pending human-approved correction.
