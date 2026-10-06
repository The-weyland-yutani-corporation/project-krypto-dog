# Operations
- Dev runs Azure Container Apps/Jobs in monitored `shadow`; production remains `disabled` with manual jobs, no promotion workflow, and no live-money path.
- Releases use OIDC/Entra, least privilege, private PostgreSQL, immutable image digests, distinct runtime/owner/operator identities, replay-safe migrations, exact-SHA evidence, and independent alerts.
- Any failed identity, migration, smoke, reconciliation, backup/restore, evidence, schedule, or alert check stops the release; rollback first forces `Manual` plus `disabled`.
- Automation may pause or disable but never unpause production, clear a drawdown lock, promote paper, expose identifiers/secrets, or enable live trading.
- Production cannot leave `disabled`/`Manual` until an approved evidence-bound promotion design exists, telemetry uses a separate production PostHog project, the 90-day production evidence policy is locked, restore proof is current, and named response ownership plus independent alerting are verified.
- Validate with the narrowest applicable lint/build/test/migration/agentic checks and the isolated mock-first harness; real-provider smoke is opt-in and read-only.
- These procedures cannot authorize production deployment or promotion; authority remains in `specs/governance.md`, with exact-release approval, restore proof, response ownership, telemetry isolation, and a separately reviewed design required.
