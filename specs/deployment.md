# Deployment runbook (Azure)

> **Implemented, not provisioned.** The Bicep templates and protected GitHub
> Actions workflows described here exist, but no Project Krypto Azure
> resource has been provisioned and no live Azure what-if, apply, ops job,
> smoke, backup, or schedule evidence exists. There is no Azure application
> URL. Treat every step as pending until retained run evidence proves it.
>
> **Paper/live safety is unchanged.** `ROLLOUT_MODE` supports only
> `disabled`, `shadow`, and `paper`. Nothing in this runbook authorizes
> live-money execution. Azure provisioning proves deployment mechanics, not
> the v2.2 or v3 evidence gates in [`readiness.md`](./readiness.md).

The target is Azure Container Apps + Jobs, private Azure Database for
PostgreSQL Flexible Server 17, Key Vault, per-environment ACR and Azure
Communication Services Email, immutable evidence storage, Azure Monitor,
GitHub Actions OIDC, and a dedicated Microsoft Foundry platform. The
historical deployment procedure is archived at
[`archive/deployment.vercel-supabase.md`](./archive/deployment.vercel-supabase.md)
and must not be used for a new release.

## 0. Approved target contract

| Setting | Approved value |
|---|---|
| Runtime-selected subscription | **Visual Studio Enterprise Subscription** |
| Region | `westus3` |
| Platform resource group | `rg-krypto-platform` |
| Dev/prod resource groups | `rg-krypto-dev` / `rg-krypto-prod` |
| Foundry account | `ai-krypto-westus3` |
| Model | OpenAI `gpt-5.6-luna`, version `2026-07-09` |
| SKU and capacity | `GlobalStandard`; dev 10 and prod 10 |
| Model deployments | `krypto-dev-luna` / `krypto-prod-luna` |
| Model auth | Microsoft Entra ID only; Foundry local auth/API keys disabled |
| Runtime model config | `AZURE_OPENAI_BASE_URL` ending `/openai/v1`, `AZURE_OPENAI_DEPLOYMENT_NAME`, `AZURE_CLIENT_ID` |
| Email | Per-environment ACS Email with Azure-managed domain |
| Analytics | Distinct PostHog project key for dev and prod |

The rejected candidate region `eastus2` is a **historical constraint, not a
target**: the selected subscription is restricted from PostgreSQL
provisioning there. All current templates and commands use `westus3`.

Do not commit or publish the subscription ID, tenant ID, identity IDs, full
Azure resource IDs, database URLs, Key Vault URLs, evidence URLs, or other
internal deployment identifiers. Protected workflow variables may carry
those values without making them public documentation.

## 1. One-time local bootstrap

An operator with the required subscription permissions selects the approved
subscription at runtime by display name:

```bash
az login
az account set --subscription "Visual Studio Enterprise Subscription"
az account show --query name --output tsv
```

The final command must print exactly `Visual Studio Enterprise Subscription`.
Do not paste its ID into an issue, log excerpt, or this repository.

Before any `bootstrap.bicep` what-if, an authorized subscription owner must
register and wait for every required Azure resource provider:

```bash
.github/scripts/azure/register-providers.sh
```

The script verifies the selected subscription is enabled, owns the reviewed
provider list, calls provider registration with `--wait`, and fails unless all
providers reach `Registered`. Protected platform/dev/prod deployment workflows
run the same script with `--check-only`; they never register providers or
mutate subscription provider state. The required list includes
`Microsoft.Network` for the VNet/private-networking foundation.

Review the subscription-scope what-if, then create the three resource groups,
four GitHub OIDC user-assigned identities, and least-privilege role bindings:

```bash
az deployment sub what-if \
  --location westus3 \
  --template-file infra/bootstrap.bicep \
  --parameters infra/params/bootstrap.bicepparam

az deployment sub create \
  --location westus3 \
  --template-file infra/bootstrap.bicep \
  --parameters infra/params/bootstrap.bicepparam
```

`bootstrap.bicep` creates:

- `rg-krypto-platform`, `rg-krypto-dev`, and `rg-krypto-prod`;
- four identities: `id-github-oidc-platform`, `id-github-oidc-dev`,
  `id-github-oidc-prod-deploy`, and `id-github-oidc-prod-promotion`;
- the custom **Project Krypto Provider Registration Reader**, containing only
  `Microsoft.Resources/subscriptions/providers/read`, assigned at subscription
  scope to the platform, dev, and prod-deploy identities; and
- one subscription-scoped, read-only **Cognitive Services Usages Reader**
  assignment for `id-github-oidc-platform`.

Record the deployment outputs in a protected operator handoff. Client and
principal IDs are configuration inputs, not documentation values.

## 2. Protected GitHub Environments

Create required-reviewer protection rules before populating values.

| Environment | Workflows | Required variables | Required secrets |
|---|---|---|---|
| `platform` | `azure-platform.yml`, `azure-platform-access.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PLATFORM_RESOURCE_GROUP_NAME`, `FOUNDRY_RESOURCE_NAME`, `PLATFORM_IDENTITY_PRINCIPAL_ID` | none |
| `development` | `azure-deploy-dev.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `DEV_RESOURCE_GROUP_NAME`, `DEV_IDENTITY_NAME` | `POSTGRES_ADMIN_PASSWORD`, `DATABASE_URL`, `DIRECT_URL`, `CRON_SECRET`, `POSTHOG_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `RUNTIME_DATABASE_PASSWORD`, `DEPLOYMENT_APPROVAL_SECRET` |
| `production-deploy` | `azure-deploy-prod.yml`, release portion of `azure-rotate-secrets.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PROD_RESOURCE_GROUP_NAME`, `PROD_DEPLOY_IDENTITY_NAME`, `PROD_PROMOTION_IDENTITY_NAME` | same names as development, with independent prod values |
| `production-promotion` | Forced-disable portions of `azure-deploy-prod.yml` and `azure-rotate-secrets.yml` only | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PROD_RESOURCE_GROUP_NAME` | none |

Bootstrap RBAC boundaries:

| Identity | Resource-group roles | Subscription read-only roles |
|---|---|---|
| `id-github-oidc-platform` | `rg-krypto-platform`: Contributor, Role Based Access Control Administrator, Locks Contributor | Project Krypto Provider Registration Reader; Cognitive Services Usages Reader |
| `id-github-oidc-dev` | `rg-krypto-dev`: Contributor, Role Based Access Control Administrator | Project Krypto Provider Registration Reader |
| `id-github-oidc-prod-deploy` | `rg-krypto-prod`: Contributor, Role Based Access Control Administrator, Locks Contributor | Project Krypto Provider Registration Reader |
| `id-github-oidc-prod-promotion` | `rg-krypto-prod`: Contributor | none |

Requirements:

- Each Environment's `AZURE_CLIENT_ID` is the matching bootstrap identity.
- `AZURE_SUBSCRIPTION_ID` stays protected; never publish its value.
- Every mutation role remains scoped to its platform/dev/prod resource group.
  Subscription roles are read-only: the one-action provider-state reader on
  platform/dev/prod-deploy, plus **Cognitive Services Usages Reader** on
  platform for live quota inspection. Neither permits provider registration or
  other subscription mutation; broad Reader is not granted.
- Locks Contributor remains resource-group-scoped: platform uses it for the
  Foundry account lock; prod deploy uses it for the prod PostgreSQL, Key Vault,
  and evidence-storage locks created by `environment.bicep`.
- Dev and prod `POSTHOG_API_KEY` values must belong to separate projects.
- There is no Foundry API-key secret.
- There is no ACS connection-string GitHub secret. `release.bicep` calls
  `listKeys()` on the per-environment Communication Service and writes the
  connection string directly to that environment's Key Vault.
- `DEPLOYMENT_APPROVAL_SECRET` is distinct from `CRON_SECRET` and is mounted
  only on `target-smoke` and `activation-check`.
- `DATABASE_URL` uses `krypto_app`; `DIRECT_URL` uses `krypto_owner`. Both
  target the same private server/database with `sslmode=require`.

## 3. Provision the dedicated Foundry platform

Run `azure-platform.yml` manually under the protected `platform` Environment.
It has separate protected mutation boundaries:

1. **Account plan** — what-if `platform-account.bicep`, reject deletes, retain
   the artifact.
2. **Account apply** — create `ai-krypto-westus3`, verify `AIServices`/`S0`,
   `westus3`, `disableLocalAuth=true`, and the `CanNotDelete` lock.
3. **Model plan** — require exactly one live catalog match for
   `OpenAI/gpt-5.6-luna/2026-07-09/GlobalStandard`; resolve its exact
   `usageName`; pass both deployment-name/capacity pairs; and validate the
   desired aggregate 10 + 10 = 20 against that one quota dimension. The quota
   calculation subtracts only existing `krypto-dev-luna`/
   `krypto-prod-luna` capacity whose format, model, version, and SKU all match
   exactly, so a rerun does not double-count replaceable target capacity. Then
   what-if `platform.bicep` and retain the artifact.
4. **Model apply** — deploy `krypto-dev-luna` and `krypto-prod-luna`, each at
   capacity 10 with `NoAutoUpgrade`, then verify exact live properties.
5. **No-trade smoke** — use the platform OIDC identity's Entra token to prove
   both a plain response and a structured `HOLD` response. It cannot trade.

An existing target name on a different dimension is not subtracted. Any
absent/ambiguous catalog or quota mapping, malformed existing capacity,
insufficient incremental quota, delete change, property mismatch, or smoke
failure blocks the platform run. No fallback model, version, SKU, region, or
capacity is allowed.

## 4. Deploy both environment foundations

`azure-deploy-dev.yml` and `azure-deploy-prod.yml` accept:

- `commit_sha`: exact 40-hex commit; and
- `deployment_stage`: `foundation` or `full`.

Automatic `workflow_run` events always select `full`. Manual SHAs must be an
ancestor of the target branch and have their own successful push-triggered CI
run.

### First dev-run caveat

GitHub evaluates a `workflow_run` trigger using the workflow file from the
repository's default branch. Therefore the **first dev deployment must be a
manual dispatch with the exact CI-passed SHA**. Do not rely on a dev push to
pick up this new workflow until the updated workflow itself has reached
`main`. Future successful pushes to `develop/azure` may auto-deploy after that.

### Foundation order

1. Manually run dev with `deployment_stage=foundation`.
2. Manually run prod with `deployment_stage=foundation`.
3. Retain both `foundation-outputs.<env>.json` artifacts.

Each foundation runs `environment.bicep` what-if with unsafe-delete rejection,
then creates the per-environment network, ACR, Container Apps environment,
private PostgreSQL, Key Vault, evidence storage, monitoring, runtime/scheduler/
ops identities, and ACS Email resources. It publishes nonsecret principal IDs,
ACS sender, evidence metadata, and monitoring IDs. It does not build images,
create a release, or enable a schedule.

Both foundations are mandatory because the next step binds all four workload
principal IDs in one account-scoped access deployment.

## 5. Bind Foundry workload access

Run `azure-platform-access.yml` only after both foundation artifacts exist.
Supply exactly the retained principal IDs for:

- dev runtime;
- dev ops;
- prod runtime; and
- prod ops.

The workflow format-validates them, runs a protected what-if job, publishes
the what-if artifact, then runs a separate protected apply job. It grants
exactly one **Cognitive Services OpenAI User** assignment per principal at the
`ai-krypto-westus3` account scope. Scheduler identities receive no Foundry
role.

Do not proceed to a full release until the live assignment verification
passes. This is the dependency bridge between the application foundations and
keyless model access.

## 6. Dev full release and schedule activation

After platform access is bound, manually run the first dev `full` release at
the exact CI-passed SHA. Subsequent eligible `develop/azure` pushes can use the
automatic path described above.

The implemented order is:

1. **Gate** the exact SHA and `full` stage.
2. **Environment** what-if/apply and publish the current foundation handoff.
3. **Build** web and ops images and resolve immutable digests.
4. **Release** what-if/apply. `release.bicep` hardcodes
   `ROLLOUT_MODE=disabled` and both scheduler jobs to `Manual`.
5. **Disabled evidence** — run `migrate-init`, `preflight`, and
   `target-smoke`; download and independently validate every immutable
   report.
6. **Stage shadow/manual** — deploy `rollout.bicep` with `shadow` while both
   jobs remain `Manual`; verify outputs and live state, then deploy and verify
   `schedule-monitoring.bicep` disabled at boundary `0`.
7. **Attended manual shadow proof** — capture a second-precision UTC boundary,
   derive a unique `manual-shadow:` idempotency key, inject it as
   `SCHEDULED_IDEMPOTENCY_KEY` into exactly one Manual hourly execution, and
   require the Container Apps execution to succeed. No schedule exists yet.
8. **Post-run activation-check** — inject the exact expected shadow key and
   boundary into a new activation-check execution. Its immutable report must
   prove the exact new SHADOW `AgentRun` started after the boundary, reached a
   safe terminal outcome, created zero `TradeExecution`, and released the
   lease.
9. **Activate Schedule with monitoring** — capture the current UTC activation
   epoch; what-if, deploy, and validate `schedule-monitoring.bicep` with the
   missing-hourly-success alert enabled; only then deploy `rollout.bicep` to
   switch both jobs to `Schedule`.
10. **Observe scheduled success** — require a successful unmarked hourly
   execution from the first scheduled window. Its idempotency namespace binds
   the exact image digest and current activation generation, so an old
   same-hour run cannot satisfy observation.
11. **Final-state verification** — prove live shadow mode, both cron
    expressions, schedule monitoring boundary, exact release SHA, exact
    web/ops digests, current idempotency generation, and the observed
    scheduled execution.

Any failure or cancellation from shadow staging onward invokes the dedicated
rollback job. It what-ifs and applies `disabled`/`Manual`, verifies both jobs
are `Manual` with no schedule, then deploys and verifies
`schedule-monitoring.bicep` disabled with boundary `0`. It reports the
original deployment as failed. A failed activation is never accepted merely
because rollback succeeded.

## 7. Prod full release (no promotion workflow)

Prod deploy and secret rotation use one concurrency group:
`azure-production-mutation`. Runs queue rather than cancel one another. No
executable production promotion workflow is shipped or approved.

`azure-deploy-prod.yml` ends disabled/manual and cannot promote. Its order is:

1. **Gate** the exact `main` SHA.
2. **Detect current release** by requiring either all eight deterministic
   release resources or none. Partial state fails closed.
3. **Force-disable current release** under `production-promotion`: when a
   complete release exists, resolve its live SHA/digest/config, what-if
   `rollout.bicep`, apply the committed `disabled`/`Manual` defaults, and
   verify both jobs are `Manual` with no schedule. Only after that verification
   deploy `schedule-monitoring.bicep` disabled at boundary `0` and verify it.
4. **Back up current release** under `production-deploy`: run and validate
   current-release `preflight` and `verified-backup`. The verified-backup
   `JOB_EXECUTION_ID` carries a `-current` suffix so a same-SHA current-release
   report cannot collide with the new-release baseline evidence path. A
   proven-fresh environment skips this step; partial or failed state cannot.
5. **Only now mutate the environment**: reverify current disabled state,
   what-if `environment.bicep`, reject unsafe deletes, and apply it. This
   ordering prevents PostgreSQL administrator rotation or other foundation
   mutation before the current release is disabled and backed up.
6. If `deployment_stage=foundation`, publish the handoff and stop.
7. For `full`, build immutable web/ops images and apply `release.bicep`,
   which lands the new release disabled/manual.
8. Run and validate new-release `migrate-init`, baseline
   `verified-backup`, and `target-smoke`.
9. Verify live prod remains disabled, both jobs are `Manual` with no schedule,
   all ops jobs carry the exact release SHA/digest, and ACR tags still resolve
   to the deployed immutable digests.

The target-smoke job summary surfaces its exact `JOB_EXECUTION_ID` for a
future evidence-bound design review. The `production-promotion`
identity/environment remains only as the protected forced-disable boundary in
prod deploy and rotation; it is not an activation path.

## 8. Ops-job execution and immutable evidence

`run-ops-job.sh` starts every evidence-producing ops invocation
(`migrate-init`, `preflight`, `verified-backup`, `target-smoke`,
`activation-check`) and the attended dev manual-shadow execution fail-closed:

1. derive a unique CI-controlled `JOB_EXECUTION_ID`;
2. fetch the complete live Container Apps Job `properties.template`;
3. fail if the live template declares any `volumes` or any container/init
   `volumeMounts`;
4. require exactly one container and replace only allowlisted per-execution
   environment entries;
5. start the execution with `az containerapp job start --yaml`;
6. poll to `Succeeded` or fail on terminal failure/timeout;
7. for evidence-producing operations, download the exact report with OIDC and
   container-scoped reader access and validate schema, pass state, release SHA,
   and where applicable image digest and signed approval.

The helper always injects `JOB_EXECUTION_ID`. For attended dev proof it may
add only these validated overrides:

- `SCHEDULED_IDEMPOTENCY_KEY` — a unique `manual-shadow:` key on the Manual
  hourly execution;
- `EXPECTED_SHADOW_IDEMPOTENCY_KEY` — the same key on the post-run
  activation-check; and
- `EXPECTED_SHADOW_STARTED_AFTER` — the second-precision UTC boundary captured
  before the manual run.

No other per-execution environment name is accepted.

Azure replaces an execution template when a start override is supplied.
Therefore the helper clones the full live template and preserves every
non-allowlisted image, environment entry, secret reference, command, retry
limit, and timeout. Azure's `JobExecutionTemplate` cannot preserve volumes, so
the helper rejects them rather than silently dropping them. Current Project
Krypto jobs declare no volumes or volume mounts. An env-only
`job start` override is unsafe because Azure can drop the rest of the live
template.

Evidence paths are:

```text
<environment>/<release-sha>/<operation>/<job-execution-id>/report.json
```

Missing, unreadable, ambiguous, or mismatched evidence is failure. The ops
identity writes to the immutable container; GitHub OIDC identities have
read-only container-scoped access. Production retention is 90 days and still
requires the documented one-time irreversible immutability-policy lock after
foundation provisioning.

## 9. Mandatory smoke gates

The following remain mandatory before schedule activation:

- exact Foundry catalog/quota validation and platform plain + structured
  no-trade smoke;
- Foundry Entra access for runtime and ops identities;
- target provider smoke for Foundry (including structured Luna output),
  Coinbase, and the environment-specific PostHog project;
- ACS Email delivery through the running app with a persisted `sent` audit;
- database/runtime binding, admin login/logout, disabled-mode no-mutation,
  lease release, and unchanged-trade checks;
- immutable signed target-smoke evidence;
- post-run activation-check evidence bound to the exact new `manual-shadow:`
  `AgentRun`, its start boundary, safe terminal outcome, zero
  `TradeExecution`, and released lease;
- cross-mode idempotency replay rejection; and
- monitoring readiness before a trigger becomes `Schedule`.

Target smoke must fail if any provider is skipped. Local console-only email
behavior is never acceptable as Azure target evidence.

## 10. Monitoring activation

`environment.bicep` creates an always-enabled scheduled-query alert for
terminal hourly/daily job failures.

`schedule-monitoring.bicep` owns the separate missing-hourly-success rule.
Its dev/prod `.bicepparam` files default to disabled at boundary `0`:

- before hourly becomes `Schedule`, the workflow passes the current UTC Unix
  timestamp, what-ifs and deploys the monitoring template, and verifies the
  enabled state and exact boundary;
- the rule validates the live Log Analytics schema before schedule resources
  change; missing schema blocks activation;
- after a two-hour grace period measured from that exact activation timestamp,
  no successful hourly execution raises a severity-1 alert; and
- only after monitoring validation succeeds may `rollout.bicep` change either
  job to `Schedule`.

The same activation epoch is the rollout's idempotency generation. The hourly
job receives `SCHEDULED_IDEMPOTENCY_NAMESPACE` bound to the exact
`sha256` image digest plus that generation; its UTC-hour key is therefore
unique to the deployed image and activation window. A same-hour run from an
older image or activation cannot be replayed as the observed scheduled run.

Disable ordering is deliberately reversed. Prod force-disable, dev rollback,
manual shadow staging, and secret rotation first apply `rollout.bicep` and
verify both jobs are `Manual` with no schedule; only then may they deploy
`schedule-monitoring.bicep` disabled at boundary `0`. This prevents an
unmonitored schedule window and prevents monitoring from being removed while
jobs may still run unattended.

## 11. Production promotion status and rotation

`.github/workflows/azure-promote-prod.yml` has been deleted. **No executable
production promotion workflow is shipped or approved**, and no
`prepare`/`activate` operator path is available. The `production-promotion`
identity/environment remains solely for forced-disable jobs inside
`azure-deploy-prod.yml` and `azure-rotate-secrets.yml`.

Any future production promotion requires a new evidence-bound design,
trading-safety review, and explicit approval before an executable workflow is
added. Readiness gates alone do not create an activation mechanism.

`azure-rotate-secrets.yml` makes and verifies both jobs Manual, disables and
verifies missing-success monitoring, backs up the current release, redeploys
the same SHA and image digests with protected secret values, reruns
target-smoke, and leaves prod disabled/manual. ACS connection strings remain
Azure-generated and are not rotation inputs from GitHub. Prod deployment and
rotation share `azure-production-mutation`.

## 12. Rollback and state updates

| Goal | Required action |
|---|---|
| Stop recurring work | Apply `rollout.bicep` with `disabled` and both triggers `Manual`; verify both jobs have no schedule; then deploy and verify `schedule-monitoring.bicep` disabled at boundary `0` |
| Recover a failed dev activation | Use the workflow's automatic rollback and investigate the failed run/evidence |
| Promote production | No current operator action exists; require a new evidence-bound design and review |
| Roll back a release | Re-run the full workflow at a prior CI-passed exact SHA; do not bypass current-release prod backup gates |
| Pause application behavior | Use the audited admin **Pause Agent** control in addition to disabling schedules |
| Retire resources | Use a separately reviewed decommission plan; resource-group deletion is not a release operation |

After a successful first deployment, update
[`architecture.md`](./architecture.md)'s live endpoint register with only the
public Container App origin and evidence link. Until then it must continue to
say **Not deployed / No URL yet**.

## Further reading

- [`../infra/README.md`](../infra/README.md) — template, identity, secret,
  monitoring, and limitation detail.
- [`architecture.md`](./architecture.md) — topology, planned names, and live
  endpoint register.
- [`readiness.md`](./readiness.md) — current evidence and promotion gates.
- [`monitoring.md`](./monitoring.md) — operational alerts and reviews.
- [`decisions/0008-azure-native-deployment-architecture.md`](./decisions/0008-azure-native-deployment-architecture.md)
  — accepted Azure architecture.
