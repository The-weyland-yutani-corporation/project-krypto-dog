# Deployment runbook (Azure)

> **Live state (2026-08-15): both Azure releases deployed.** Dev is
> `shadow` with monitored hourly/daily schedules. Production is `disabled`
> with all jobs `Manual`. Migration, provider/email/admin target smoke,
> restore-verified production backup, alert delivery, and exact-digest checks
> passed. No production promotion is shipped or authorized.
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
| Operational Foundry account | Established `ghcp-foundry-eastus2` (temporary shared model host) |
| Dedicated future account | `ai-krypto-westus3` (live, local auth disabled, model-empty after `715-123420`) |
| Model | OpenAI `gpt-5.6-luna`, version `2026-07-09` |
| SKU and capacity | `GlobalStandard`; dev 10 and prod 10 |
| Model deployments | `krypto-dev-luna` / `krypto-prod-luna` |
| Model auth | Project Krypto uses Microsoft Entra ID only; no model API key is stored or mounted |
| Agent projects | `krypto-dev-agents` / `krypto-prod-agents` |
| Agent names | `krypto-dev-decision` / `krypto-prod-decision` |
| Runtime agent config | `AZURE_FOUNDRY_PROJECT_ENDPOINT`, `AZURE_FOUNDRY_AGENT_NAME`, immutable `AZURE_FOUNDRY_AGENT_VERSION`, `AZURE_CLIENT_ID` |
| Runtime agent auth | Project-scoped custom **Project Krypto Foundry Agent Invoker**; no agent or model API key |
| Email | Per-environment ACS Email with Azure-managed domain |
| Analytics | Every event carries mandatory `deployment_environment`; a distinct dev project remains required before production promotion |

The rejected candidate region `eastus2` is a **historical constraint, not a
target**: the selected subscription is restricted from PostgreSQL
provisioning there. All current templates and commands use `westus3`.

Do not commit or publish the subscription ID, tenant ID, identity IDs, full
Azure resource IDs, database URLs, Key Vault URLs, evidence URLs, or other
internal deployment identifiers. Protected workflow variables may carry
those values without making them public documentation.

### Current live checkpoint

| Stage | Live state | Evidence |
|---|---|---|
| Providers/bootstrap | Required providers are registered; platform/dev/prod resource groups and four GitHub OIDC identities exist | Complete |
| GitHub controls | Enterprise-hosted Actions are active; `CI_RUNNER_LABEL` is unset and no self-hosted runner is registered. Platform and production environments require `@VeVarunSharma` review with `prevent_self_review=false`; development intentionally has no reviewer. Branch, exact-SHA, and CI gates remain mandatory. | Hosted execution and approvals active |
| Foundry platform | Dedicated account remains model-empty after `715-123420`; fallback dev/prod Luna deployments and isolated prompt agents on `ghcp-foundry-eastus2` succeeded. Both immutable agent version `1` deployments passed exact structured `HOLD` smokes. | Operational agents complete |
| Workload access | Dev runtime/ops have the proven custom-only Project Krypto Foundry Agent Invoker. The reviewed source grants prod the same project-scoped role, but live prod remains untouched until an approved apply. Legacy account-scoped direct-model roles remain until each pre-agent image is replaced. | Dev proven; prod source ready; compatibility-role removal pending cutover |
| Dev release | Live in shadow; manual activation and first scheduled execution passed with zero trades | Retained exact-SHA evidence |
| Prod release | Live disabled/manual; migration, restore-verified backup, target smoke, and no-schedule checks passed | Release `ce7acc872f05899691ae44d4d826c9c8c94355c7` |
| Release/rollout | Dev Schedule active; production has no schedule or promotion workflow | Complete for approved deployment scope |

The dedicated account can be revisited through portal/account support, but it
does not block the deployed fallback. Dev and prod use the shared PostHog
ingestion key only with
the mandatory environment property; this permits dev validation without
misclassifying dev events as prod, but separate projects remain mandatory
before any future production promotion workflow is designed.

## 1. One-time local bootstrap

**Current status: complete.** Re-run only for reviewed bootstrap drift; do not
publish its protected outputs.

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
providers reach `Registered`. Environment-scoped platform/dev/prod deployment
workflows run the same script with `--check-only`; they never register providers
or mutate subscription provider state. The required list includes
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
- the custom **Project Krypto Foundry Agent Invoker** role definition with exact
  agent read/write, Responses read/write, and endpoint-interaction data actions
  and no subscription-level assignment; and
- one subscription-scoped, read-only **Cognitive Services Usages Reader**
  assignment for `id-github-oidc-platform`.

Record the deployment outputs in a protected operator handoff. Client and
principal IDs are configuration inputs, not documentation values.

## 2. GitHub Environments and approval gates

**Current status: Enterprise-hosted execution and reviewer enforcement active.**
Run `31981510383` proved hosted Actions after transfer. `CI_RUNNER_LABEL` is
unset, and the temporary Azure self-hosted runner registrations and runner
resource group are retired. All four environments enforce branch policies.
Platform and production
mutations require live environment approval in addition to the configured
branch, exact 40-hex SHA, and successful CI. Development intentionally omits a
reviewer so routine dev delivery can proceed through the remaining gates.

| Environment | Approval policy | Workflows | Required variables | Required secrets |
|---|---|---|---|---|
| `platform` | Required reviewer `@VeVarunSharma`; `prevent_self_review=false` | `azure-platform.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PLATFORM_RESOURCE_GROUP_NAME`, `FOUNDRY_RESOURCE_NAME`, `PLATFORM_IDENTITY_PRINCIPAL_ID` | none |
| `development` | No required reviewer (intentional); branch/exact-SHA/CI gates remain | `azure-deploy-dev.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `DEV_RESOURCE_GROUP_NAME`, `DEV_IDENTITY_NAME` | `POSTGRES_ADMIN_PASSWORD`, `DATABASE_URL`, `DIRECT_URL`, `CRON_SECRET`, `POSTHOG_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `RUNTIME_DATABASE_PASSWORD`, `DEPLOYMENT_APPROVAL_SECRET` |
| `production-deploy` | Required reviewer `@VeVarunSharma`; `prevent_self_review=false` | `azure-deploy-prod.yml`, release portion of `azure-rotate-secrets.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PROD_RESOURCE_GROUP_NAME`, `PROD_DEPLOY_IDENTITY_NAME`, `PROD_PROMOTION_IDENTITY_NAME` | same names as development, with independent prod values |
| `production-promotion` | Required reviewer `@VeVarunSharma`; `prevent_self_review=false`; forced-disable boundary only | Forced-disable portions of `azure-deploy-prod.yml` and `azure-rotate-secrets.yml` only | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PROD_RESOURCE_GROUP_NAME` | none |

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
- `POSTHOG_ENVIRONMENT` must be `dev` or `prod` and is attached to every event.
  The temporary shared key is accepted for dev validation only; separate
  projects remain required before future production promotion.
- `APP_ORIGIN` is the exact HTTPS Container App origin. Admin CSRF validation
  uses it instead of the reverse proxy's internal request URL and rejects a
  missing or non-origin value in production.
- There is no Foundry API-key secret.
- There is no ACS connection-string GitHub secret. `release.bicep` calls
  `listKeys()` on the per-environment Communication Service and writes the
  connection string directly to that environment's Key Vault.
- `DEPLOYMENT_APPROVAL_SECRET` is distinct from `CRON_SECRET` and is mounted
  only on `target-smoke` and `activation-check`.
- `DATABASE_URL` uses `krypto_app`; `DIRECT_URL` uses `krypto_owner`. Both
  target the same private server/database with `sslmode=require`.

## 3. Provision the Foundry model platform

**Current status: operational fallback live.** The
[platform run](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/31839812884)
created and verified `ai-krypto-westus3`, disabled local auth, verified the
`CanNotDelete` lock, and passed exact catalog/quota validation. Azure rejected
model deployment with error `715-123420` (“unusual activity”). The exact dev
and prod Luna deployments were then created serially on the established
`ghcp-foundry-eastus2` account, granted to the four workload identities with
**Cognitive Services OpenAI User**, and passed Entra plain plus strict
structured `HOLD` smokes. Those account-scoped roles are now a temporary
compatibility bridge for the deployed pre-agent image; the new projects use
the project-scoped custom invoker and the old roles are removed only after the
agent-integrated image passes target smoke. Keep the dedicated account for a
future migration.

`azure-platform.yml` remains the dedicated-account migration workflow. It has
separate what-if/apply mutation boundaries:

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

**Current status: complete.** The
[dev foundation run](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/31841581875)
and
[prod foundation run](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/31841960745)
passed. Both foundations now contain ACR, private PostgreSQL 17, Key Vault,
evidence storage, a Container Apps environment, ACS Email with an Azure-managed
domain, Log Analytics/alerts, and runtime/scheduler/ops identities. Neither run
created a release, web Container App, or job.

`azure-deploy-dev.yml` and `azure-deploy-prod.yml` accept:

- `commit_sha`: exact 40-hex commit; and
- `deployment_stage`: `foundation` or `full`.

The workflow definition maps `workflow_run` events to `full`, but automatic
development mutation remains subject to the configured branch and the
triggering SHA's successful push-triggered CI run. Manual SHAs must be ancestors
of the configured target branch and have their own successful CI run.

### First dev-run caveat

GitHub evaluates a `workflow_run` trigger using the workflow file from the
repository's default branch. Do not rely on a feature-branch workflow version:
the default-branch workflow must contain the reviewed trigger and exact-SHA/CI
gates. Manual dispatch remains available only for an exact CI-passed SHA.

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

Both foundations are mandatory because the next step binds each runtime/ops
principal to its matching Foundry project. The four principal IDs are supplied
explicitly to the reviewed `foundry-agents.bicep` deployment.

## 5. Deploy Foundry agents and bind workload access

**Current status: agent resources complete; dev access proven; prod access
source ready; app cutover pending.** `infra/foundry-agents.bicep` creates separate dev/prod projects,
assigns Foundry User to each project identity and attended deployer, and assigns
Project Krypto Foundry Agent Invoker to only the matching runtime/ops identities.
Scheduler identities receive no Foundry role. The custom-only assignment is
proven live in dev; production source is reviewed here but live prod remains
unchanged until an approved apply.

The custom role has empty `Actions`, `NotActions`, and `NotDataActions`. Its only
data actions are `agents/read`, `agents/write`, `responses/read`,
`responses/write`, and `endpoints/interact/action`. Incremental ARM deployment
does not delete superseded assignments, so rollout evidence must verify the
three partial built-ins are absent and exactly one custom invoker remains per
runtime/ops identity.

The authenticated local operator path was used for the historical first
deployment before Enterprise-hosted Actions became available. The reviewed
`npm run foundry:agent` command deployed a toolless prompt agent in each project,
fetched and exactly attested the persisted definition, and invoked the exact
version with a no-trade structured `HOLD`.

The deployed versions are pinned in the reviewed release/rollout parameter
files. Changing a version therefore requires a source review. Target smoke
invokes that exact version and then repeats database postconditions to prove no
trade was added and the lease remains released.

Do not delete legacy account-scoped Cognitive Services OpenAI User assignments
until that environment's new app image passes target smoke. The live pre-agent
image still uses direct model inference, so early deletion would break dev
shadow runs. After cutover, delete the legacy assignment and verify that only
the project-scoped custom invoker remains.

## 6. Dev full release and schedule activation

**Current status: pre-agent release live; agent cutover pending.** Dev is
shadow/scheduled on the previously validated image. The Foundry prompt agent is
active and smoke-tested, but the new app image remains pending the reviewed
source merge and gated release. Run `full` only at the exact CI-passed SHA;
Enterprise-hosted Actions and the development environment are available.

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

**Current status: complete for the approved disabled/manual scope.** Production
release `ce7acc872f05899691ae44d4d826c9c8c94355c7` is deployed; all seven jobs
are Manual and there is no schedule.

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
read-only container-scoped access. Production retention is 90 days. Its policy remains `Unlocked`; locking it is a
separate irreversible operator decision, not implied by deployment.

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

The public origins are recorded in
[`architecture.md`](./architecture.md). Keep private database, Key Vault,
evidence-storage, identity, and full resource identifiers out of public docs.

## Further reading

- [`../infra/README.md`](../infra/README.md) — template, identity, secret,
  monitoring, and limitation detail.
- [`architecture.md`](./architecture.md) — topology, planned names, and live
  endpoint register.
- [`readiness.md`](./readiness.md) — current evidence and promotion gates.
- [`monitoring.md`](./monitoring.md) — operational alerts and reviews.
- [`decisions/0008-azure-native-deployment-architecture.md`](./decisions/0008-azure-native-deployment-architecture.md)
  — accepted Azure architecture.
