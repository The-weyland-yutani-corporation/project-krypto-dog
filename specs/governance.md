# Governance

- Repository policy provides standing authorization for same-repository
  software delivery. Agents may propose and implement architecture and factory
  changes within the mission; automated, current-head verification decides
  whether those changes are ready to merge.
- Preserve deterministic application authorization, accounting,
  reconciliation, leases, idempotency, journaling, and admin authentication.
  Delivery autonomy is not permission to disable correctness checks.
- Credentials and external-account access remain independently scoped.
  No repository instruction authorizes real-money transactions or transfers.
- Production delivery must retain exact-release provenance, migrations,
  backups, rollback, health checks, and the permissions enforced by GitHub
  Environments and Azure. A source change is not proof of a live rollout.
- Keep canonical requirements in the five existing specification files.
  Machine-readable lists remain in `.github/agentic-policy.json`.