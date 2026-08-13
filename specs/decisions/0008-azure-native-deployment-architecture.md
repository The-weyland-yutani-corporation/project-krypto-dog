# 0008 — Azure-native deployment architecture

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** @VeVarunSharma

## Context

Project Krypto's shipped code baseline targets Vercel (app hosting) +
Supabase (PostgreSQL + `pg_cron`/`pg_net` scheduling), with the LLM already
served through an existing Azure AI Foundry account. ADR 0003 recorded the
Supabase `pg_cron`-over-Vercel-Cron choice within that Vercel/Supabase
target.

The approved deployment plan moves the target platform to Azure end to end:
application hosting, database, secrets, and scheduling all move onto Azure
primitives, replacing Vercel and Supabase as the deployment target. This ADR
records that platform decision and the operational model it implies.

**Implementation status (updated 2026-08-12): implemented, not yet
provisioned.** The Bicep templates (`infra/`), the GitHub Actions OIDC
deployment/promotion/rotation workflows, and the application-side
deployment/ops-job code (`src/deployment/`, `scripts/azure/`) described
by this ADR all exist in this repository now — see
[`infra/README.md`](../../infra/README.md) and
[`specs/deployment.md`](../deployment.md) for the implemented runbook.
Local validation (Bicep compile, `.bicepparam` build, ops-job unit tests)
passes. An Azure subscription and existing Foundry service(s) are available,
but **no Project Krypto Azure resource group or environment has been
provisioned from this code, and no workflow run has ever executed against
the new target stack** — that remains gated by the existing
readiness process in `specs/production-readiness-prd.v1.md` and requires
the one-time bootstrap and GitHub Environment setup in
`specs/deployment.md` §1–§2.
See [`specs/architecture.md`](../architecture.md) for the diagrammed
current-vs-target state and service map.

## Decision

**Adopt a fully Azure-native target for application hosting, database,
secrets, and scheduling**, superseding
[0003-pg-cron-over-vercel-cron.md](./0003-pg-cron-over-vercel-cron.md) and
its Vercel/Supabase framing.

1. **Application hosting: Azure Container Apps.** The Next.js app runs as a
   Container Apps app. Scheduled invocation of the agent-run and
   daily-summary routes, and one-off operator actions (backup/restore
   verification, smoke, secret-rotation follow-up), run as separate Container
   Apps **Jobs** — scheduled jobs for recurring triggers, manually-triggered
   jobs for operator-invoked actions. This replaces both Vercel hosting and
   the Supabase `pg_cron`/`pg_net` trigger path from ADR 0003.

2. **Database: Azure Database for PostgreSQL Flexible Server, version 17,
   reachable only over private VNet access.** No public endpoint. This
   replaces Supabase Postgres. The private/restricted-role separation already
   required by ADR 0006 and `specs/production-readiness-prd.v1.md` §7.3
   (owner/migrator/scheduler/runtime separation) continues to apply on the
   Azure-hosted server.

3. **Secrets: Azure Key Vault.** All application, scheduler, and rotation
   secrets move from Supabase Vault / Vercel environment variables to Key
   Vault, referenced by managed identity. This is the sole secret store for
   the Azure target.

4. **Infrastructure as code: Bicep.** All Azure resources (Container Apps
   environment/app/jobs, Flexible Server, VNet/private endpoints, Key Vault,
   Container Registry, Foundry model deployments) are declared in Bicep.
   There is no console-managed production resource.

5. **CI/CD identity: GitHub Actions using OIDC federation.** Deployment
   workflows authenticate to Azure via OIDC-federated credentials; no
   long-lived Azure credential is stored in GitHub secrets.

6. **Environment isolation: separate dev and prod resource groups and
   separate container registries.** Dev and prod never share a resource
   group or a registry. This mirrors, at the infrastructure level, the
   environment separation already required by
   `specs/production-readiness-prd.v1.md` §7.2.

7. **LLM: reuse the existing Azure AI Foundry account with separate model
   deployments per environment, sharing the account's quota/key boundary.**
   Dev and prod get distinct Foundry **model deployments** (so a runaway dev
   workload cannot starve prod's model capacity in isolation and deployment
   configuration/rotation stays independent per environment), but both
   deployments live under the one existing Foundry account/subscription
   quota and key boundary — a new Foundry account is not created per
   environment.

8. **Production availability: single-zone initially, with 35-day
   point-in-time-recovery (PITR).** Zone-redundant HA is deferred; PITR
   window is set to the maximum operationally required for this stage
   (35 days), not the default.

9. **Backup restore verification: logical `pg_dump` into a scratch loopback
   PostgreSQL instance run inside an ops job.** Continuing the pattern
   already used against Supabase (`specs/deployment.md` Step 5 —
   `deployment:backup --restore-test-url` against a loopback-only target),
   restore verification on Azure runs the same logical dump/restore/row-count
   comparison, but the scratch PostgreSQL instance and the comparison run
   inside a Container Apps ops job rather than a developer machine, so it can
   run unattended and on a schedule while remaining restricted to a
   throwaway, loopback-only database.

10. **Scheduler state is recovered from Bicep/Git, not from the database.**
    Unlike the Supabase model in ADR 0003 — where schedule definitions lived
    in database-side `pg_cron` job rows — Container Apps Jobs' schedule
    definitions are Bicep resources. Recovery/disaster-recovery reconstructs
    scheduling by redeploying the reviewed Bicep/Git state, not by reading or
    restoring scheduler rows from the database. The database backup/restore
    path (item 9) covers application and accounting data only.

11. **Secret rotation procedure:** disable schedules first, rotate the
    secret in Key Vault, refresh the affected Container Apps revision(s) to
    pick up the new secret, rerun smoke and secret-binding verification
    against the refreshed revision, and only then request a **separate**
    promotion approval to re-enable schedules. Rotation never re-enables
    schedules as a side effect of a passing smoke run.

12. **Production deploy and schedule activation are two distinct, separately
    approved steps.** A production deploy always lands with schedules
    disabled — there is no path that deploys and activates in one action.
    Schedule activation is a separate approval that requires the disabled
    deploy's smoke/binding evidence to already exist; it is not implied by a
    successful deploy. This preserves, on the new platform, the same
    disabled-first-then-attended-promotion shape already required by
    `specs/production-readiness-prd.v1.md` PR-G1/PR-G3.

## Consequences

- **Positive:** One cloud provider owns compute, database, secrets, registry,
  and scheduling, removing the Vercel/Supabase/Azure three-way split and the
  cross-provider webhook trust boundary ADR 0003 depended on.
- **Positive:** OIDC federation removes long-lived Azure credentials from
  GitHub Actions.
- **Positive:** Private-VNet-only database access removes the public Postgres
  endpoint that existed under Supabase.
- **Positive:** Scheduler definitions as Bicep/Git resources make schedule
  state reviewable in the same PR process as application code, and
  recoverable by redeploy rather than by a separate database-side restore.
- **Trade-off:** Single-zone prod accepts a regional-outage gap until
  zone-redundant HA is implemented; 35-day PITR is the mitigating control in
  the interim.
- **Trade-off:** Shared Foundry account quota/key boundary means a
  misbehaving dev model deployment can still exhaust subscription-level
  quota or require a shared key rotation, even though deployments are
  otherwise separated.
- **Trade-off:** Container Apps Jobs' Bicep-defined schedules mean an
  uncommitted or unreviewed manual schedule change is not captured by the
  Git-based recovery path in item 10; operational changes to schedules must
  go through Bicep, not console edits.
- **Follow-ups required:** the Bicep templates, OIDC-federated GitHub
  Actions workflows, ops-job scratch-loopback restore verification, and
  rotation/promotion runbooks described above are now implemented (see
  "Implementation status" above). What remains is operational, not code:
  complete the one-time bootstrap and GitHub Environment/secret setup in
  `specs/deployment.md` §1–§2, run the first real dev deploy, and produce
  the first live evidence (preflight/backup/target-smoke reports) against
  an actually-provisioned Azure environment. `specs/deployment.md` is now
  the Azure ordered runbook; the prior Vercel/Supabase runbook is
  preserved at `specs/archive/deployment.vercel-supabase.md`. `specs/readiness.md`
  is updated to record implementation-complete-but-unprovisioned status
  and does not yet contain any live-environment evidence for this target.

## Alternatives considered

- **Stay on Vercel + Supabase, keep ADR 0003 as-is:** rejected — the approved
  deployment plan requires a single-cloud, VNet-isolated, IaC-managed target;
  Vercel/Supabase cannot provide private-VNet-only Postgres access or
  Bicep-managed scheduling.
- **Azure Functions/App Service instead of Container Apps:** rejected for
  this stage — Container Apps Jobs give a uniform scheduled/manual-trigger
  model for both the recurring agent triggers and one-off operator actions
  (backup restore verification, rotation follow-up) without adding a second
  compute primitive.
- **New, separate Foundry account per environment:** rejected — the existing
  Foundry account is retained to avoid re-provisioning model access and
  quota from scratch; separate model deployments give per-environment
  configuration/rotation isolation without a second account.
- **Zone-redundant HA at initial launch:** deferred, not rejected outright —
  single-zone plus 35-day PITR is accepted as the initial production posture;
  HA is a future hardening step once the single-cloud migration itself is
  proven.
- **Database-side (e.g., `pg_cron`-style) scheduling on Azure:** rejected —
  Container Apps Jobs' Bicep-defined schedules keep scheduler state in the
  same reviewed IaC/Git history as the rest of the infrastructure, consistent
  with item 10's recovery model.
