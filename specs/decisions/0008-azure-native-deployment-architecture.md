# 0008 — Azure-native deployment architecture

- **Status:** Accepted
- **Date:** 2026-08-12
- **Amended:** 2026-08-13 — dedicated Bicep-managed Foundry platform,
  pinned Luna deployments, and keyless workload access; 2026-08-14 — no
  shipped production promotion workflow and independently ordered schedule
  monitoring; least-privilege provider-state reads, scoped lock management,
  and idempotent quota validation
- **Deciders:** @VeVarunSharma

## Context

Project Krypto's shipped code baseline targeted Vercel (app hosting) +
Supabase (PostgreSQL + `pg_cron`/`pg_net` scheduling), with model integration
targeting Azure AI Foundry. ADR 0003 recorded the
Supabase `pg_cron`-over-Vercel-Cron choice within that Vercel/Supabase
target.

The approved deployment plan moves the target platform to Azure end to end:
application hosting, database, secrets, and scheduling all move onto Azure
primitives, replacing Vercel and Supabase as the deployment target. This ADR
records that platform decision and the operational model it implies.

**Implementation status (updated 2026-08-14): implemented, not yet
provisioned.** The Bicep templates (`infra/`), the GitHub Actions OIDC
deployment/forced-disable/rotation workflows, and the application-side
deployment/ops-job code (`src/deployment/`, `scripts/azure/`) described
by this ADR all exist in this repository now — see
[`infra/README.md`](../../infra/README.md) and
[`specs/deployment.md`](../deployment.md) for the implemented runbook.
The target selects **Visual Studio Enterprise Subscription** at runtime and
uses `westus3`, but **no Project Krypto Azure resource group, dedicated
Foundry account, model deployment, or environment has been provisioned from
this code, and no workflow run has executed against the new target stack**.
That remains gated by [`specs/readiness.md`](../readiness.md) and requires the
subscription-owner provider-registration step, one-time bootstrap, and GitHub
Environment setup in
[`specs/deployment.md`](../deployment.md) §1–§2.
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
   required by ADR 0006 and [`specs/readiness.md`](../readiness.md)
   (owner/migrator/scheduler/runtime separation) continues to apply on the
   Azure-hosted server.

3. **Secrets: Azure Key Vault.** All application, scheduler, and rotation
   secrets move from Supabase Vault / Vercel environment variables to Key
   Vault, referenced by managed identity. This is the sole secret store for
   the Azure target.

4. **Infrastructure as code: Bicep.** Azure resources (Container Apps
   environment/app/jobs, Flexible Server, VNet/private database networking,
   Key Vault, Container Registry, Foundry account/model deployments) are
   declared in Bicep. The documented one-time irreversible evidence-retention
   policy lock remains an attended post-foundation action because Azure does
   not expose that lock operation as a Bicep property; ad hoc console
   configuration is otherwise not part of the release.

5. **CI/CD identity: GitHub Actions using OIDC federation.** Deployment
   workflows authenticate to Azure via OIDC-federated credentials; no
   long-lived Azure credential is stored in GitHub secrets. All mutation
   permissions remain resource-group-scoped. Bootstrap defines **Project
   Krypto Provider Registration Reader** with only
   `Microsoft.Resources/subscriptions/providers/read` and assigns it at
   subscription scope to platform/dev/prod-deploy so workflow `--check-only`
   does not require broad Reader. Platform additionally receives read-only
   **Cognitive Services Usages Reader**. Platform and prod-deploy receive Locks
   Contributor only in their own resource groups for the Foundry account and
   prod PostgreSQL/Key Vault/evidence-storage locks, respectively. An
   authorized subscription owner registers required providers, including
   `Microsoft.Network`, before bootstrap; workflows cannot perform that
   subscription mutation.

6. **Environment isolation: separate dev and prod resource groups and
   separate container registries.** Dev and prod never share a resource
   group or a registry. This mirrors, at the infrastructure level, the
   environment separation required by
   [`specs/readiness.md`](../readiness.md).

7. **LLM: create one dedicated Bicep-managed Microsoft Foundry platform
   account with separate pinned model deployments and keyless access.**
   `rg-krypto-platform` owns `ai-krypto-westus3`, separate from the dev/prod
   application resource groups. It hosts OpenAI `gpt-5.6-luna` version
   `2026-07-09` as `GlobalStandard` deployments `krypto-dev-luna` and
   `krypto-prod-luna`, capacity 10 each. Account local authentication is
   disabled. Dev/prod runtime and ops user-assigned identities receive only
   **Cognitive Services OpenAI User**; there is no shared model API-key
   boundary. Catalog and quota checks receive the exact target
   deployment-name/capacity pairs. They validate the desired aggregate 10 + 10
   against one exact quota dimension after subtracting only exact existing
   target capacity on that same format/model/version/SKU dimension, so reruns
   do not double-count replaceable capacity.

   Runtime inference was subsequently moved behind toolless, version-pinned
   Foundry prompt agents by [ADR 0009](./0009-foundry-prompt-agent-boundary.md);
   this item remains the model-hosting contract.

8. **Production availability: single-zone initially, with 35-day
   point-in-time-recovery (PITR).** Zone-redundant HA is deferred; PITR
   window is set to the maximum operationally required for this stage
   (35 days), not the default.

9. **Backup restore verification: logical `pg_dump` into a scratch loopback
   PostgreSQL instance run inside an ops job.** Restore verification on Azure
   runs the reviewed logical dump/restore/row-count comparison, but the
   scratch PostgreSQL instance and the comparison run inside a manually
   triggered Container Apps ops job rather than a developer machine. The
   protected workflow validates its immutable report while the restored
   database remains throwaway and loopback-only.

10. **Scheduler state is recovered from Bicep/Git, not from the database.**
    Unlike the Supabase model in ADR 0003 — where schedule definitions lived
    in database-side `pg_cron` job rows — Container Apps Jobs' schedule
    definitions are Bicep resources. Recovery/disaster-recovery reconstructs
    scheduling by redeploying the reviewed Bicep/Git state, not by reading or
    restoring scheduler rows from the database. The database backup/restore
    path (item 9) covers application and accounting data only.

11. **Secret rotation procedure:** apply and verify both scheduler jobs as
    `Manual`, then disable and verify missing-success monitoring, rotate the
    secret in Key Vault, refresh the affected Container Apps revision(s), and
    rerun smoke and secret-binding verification. Rotation leaves production
    disabled/manual and never re-enables schedules as a side effect.

12. **Production deploy cannot activate a schedule.** A production deploy
    always lands disabled/manual. No executable production promotion workflow
    is shipped or approved. The `production-promotion` identity/environment is
    retained only for forced-disable portions of prod deploy and secret
    rotation. Any future schedule activation requires a new evidence-bound
    design, trading-safety review, and explicit approval; passing deployment
    smoke does not create an activation path.

13. **Schedule monitoring is independently deployed with asymmetric safe
    ordering.** `schedule-monitoring.bicep` owns the missing-hourly-success
    alert and activation boundary; `rollout.bicep` owns only web mode and job
    trigger state. Workflows enable and validate monitoring before changing
    jobs to `Schedule`. To disable, roll back, or rotate, they first change and
    verify both jobs as `Manual`, then disable monitoring at boundary `0`.

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
- **Trade-off:** The dedicated Foundry account still hosts both environment
  deployments, so subscription/account-level quota remains aggregate even
  though names, capacities, identities, and runtime configuration are
  separated. Entra-only access removes shared model-key rotation.

- **Trade-off:** Container Apps Jobs' Bicep-defined schedules mean an
  uncommitted or unreviewed manual schedule change is not captured by the
  Git-based recovery path in item 10; operational changes to schedules must
  go through Bicep, not console edits.
- **Follow-ups required:** the Bicep templates, OIDC-federated GitHub
  Actions deployment/forced-disable/rotation workflows, ops-job
  scratch-loopback restore verification, and runbooks described above are
  implemented (see "Implementation status" above). What remains before the
  first disabled/manual release is operational:
  register the required providers, complete the one-time bootstrap and GitHub
  Environment/secret setup in `specs/deployment.md` §1–§2, run the first real
  dev deploy, and produce
  the first live evidence (preflight/backup/target-smoke reports) against
  an actually-provisioned Azure environment. `specs/deployment.md` is now
  the Azure ordered runbook; the prior Vercel/Supabase runbook is
  preserved at `specs/archive/deployment.vercel-supabase.md`. `specs/readiness.md`
  is updated to record implementation-complete-but-unprovisioned status
  and does not yet contain any live-environment evidence for this target.
  Production promotion remains a separate future design/review task; it is
  intentionally not executable in the current repository.

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
- **Separate Foundry account per environment:** rejected — one dedicated
  Bicep-managed platform account keeps account lifecycle and exact aggregate
  quota validation centralized, while separate pinned deployments and
  workload identities preserve environment-specific runtime configuration.
- **Zone-redundant HA at initial launch:** deferred, not rejected outright —
  single-zone plus 35-day PITR is accepted as the initial production posture;
  HA is a future hardening step once the single-cloud migration itself is
  proven.
- **Database-side (e.g., `pg_cron`-style) scheduling on Azure:** rejected —
  Container Apps Jobs' Bicep-defined schedules keep scheduler state in the
  same reviewed IaC/Git history as the rest of the infrastructure, consistent
  with item 10's recovery model.
