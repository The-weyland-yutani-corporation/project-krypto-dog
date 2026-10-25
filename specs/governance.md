# Governance

## Accepted software-autonomy decision

On 2026-10-18 the repository owner explicitly confirmed in the factory
recovery session: "keep unrestricted self modifcation - full access that's
the governance decision".

This accepts repository software self-modification, including factory and
architecture source changes, under the standing mission in
`.github/agentic-policy.json`. It replaces the prior blanket per-change
administrator merge gate for same-repository boundary software. It does
not remove required verification or authorize secret disclosure or platform
permission bypass. The application is permanently paper-only.
An explicit emergency pause still requires owner-authorized resume.

## Accepted paper-only POC decision

The owner confirmed that development and production remain real Azure
deployments of a permanently paper-only proof of concept. There is no
future live-execution proposal, enablement approval, or alternative trading
engine. Keep simulated accounting and application guardrails.

The approved delivery design promotes an exact, verified release to scheduled
paper production through trusted native workflows, without per-release human
approval after commissioning. Required reviews, health, migrations/restore,
signed release evidence, actual scheduled-run proof, and basic failure alerts
remain gates. Separate analytics projects/private backend queries, final
mailbox-delivery proof, formal response sign-off, and irreversible retention
locking are optional enhancements, not POC activation prerequisites.

This decision does not assert that promotion is implemented or commissioned.
The current factory/deployment holds, specific tool denials, and separate
approvals for exact external settings and first activation remain effective.
Evidence repair must use existing workflow identities without additional
Azure readback grants. Preserve existing retention and old resources.

## Continuing controls

- Repository policy provides standing authorization for same-repository
  software delivery. Agents may propose and implement architecture and factory
  changes within the mission; automated, current-head verification decides
  whether those changes are ready to merge.
- Preserve deterministic application authorization, accounting,
  reconciliation, leases, idempotency, journaling, and admin authentication.
  Delivery autonomy is not permission to disable correctness checks.
- Credentials and external-account access remain independently scoped.
  The permanent paper-only product contract has no human-approval exception.
- Production delivery must retain exact-release provenance, migrations,
  backups, rollback, health checks, and the permissions enforced by GitHub
  Environments and Azure. A source change is not proof of a live rollout.
- Keep canonical requirements in the five existing specification files.
  Machine-readable lists remain in `.github/agentic-policy.json`.
- Retired spec paths embedded in applied migration comments resolve through Git history;
  never rewrite migration bytes merely to refresh a documentation link.