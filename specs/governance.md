# Governance

## Accepted software-autonomy decision

On 2026-10-18 the repository owner explicitly confirmed in the factory
recovery session: "keep unrestricted self modifcation - full access that's
the governance decision".

This accepts repository software self-modification, including factory and
architecture source changes, under the standing mission in
`.github/agentic-policy.json`. It replaces the prior blanket per-change
administrator merge gate for same-repository boundary software. It does
not remove required verification, authorize secret disclosure or platform
permission bypass, or turn the financial research hypothesis into authority
to execute real-money trades or transfers. The application remains paper-only.
An explicit emergency pause still requires owner-authorized resume.

## Continuing controls

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
- Retired spec paths embedded in applied migration comments resolve through Git history;
  never rewrite migration bytes merely to refresh a documentation link.