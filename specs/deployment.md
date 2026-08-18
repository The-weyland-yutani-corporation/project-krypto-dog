# Deployment runbook (Azure)

> **Live state (2026-08-15): both Azure releases deployed.** Dev is
> `shadow` with monitored hourly/daily schedules. Production is `disabled`
> with all jobs `Manual`. Migration, provider/email/admin target smoke,
> restore-verified production backup, alert delivery, and exact-digest checks
> passed. Those historical alert records are not OPS-01 outbox, catalog, roster,
> drill, or exact-release evidence. No production promotion is shipped or
> authorized.
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
| Application runtime | Node.js 22.13.0, pinned by `.nvmrc`, package engines, and both Docker targets |
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

### Bounded synchronous release contract

A release containing [ADR 0012](./decisions/0012-bounded-synchronous-execution.md) must preserve this ordering:

| Boundary | Value |
|---|---:|
| Provider aggregate | `125 s` (`20` Coinbase + `80` version-pinned Foundry + `20` ACS + `5` PostHog) |
| Application absolute deadline | `180 s` |
| Scheduler HTTP timeout | `210 s` |
| ACA ingress platform bound | `240 s` |
| Scheduler job replica timeout | `270 s` |
| Owned lease expiry | `300 s` |

The app window reserves `125 s` providers, `20 s` database policy/execution, `15 s` terminal persistence and owned-lease release, `10 s` cancellation/response, and `10 s` slack. Both scheduled jobs use `replicaRetryLimit=0`; the scheduler makes one HTTP attempt, with idempotency retained only as defense in depth. Manual ops jobs are not part of the trading lease/deadline chain and retain the job-specific long-running timeouts declared in `release.bicep`.

Web capacity is maximum three replicas with one pooled runtime database connection and one admitted run per replica. The runtime login has `CONNECTION LIMIT 20`; connect, statement, lock, and idle-in-transaction timeouts are 5, 10, 2, and 15 seconds respectively.

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
| GitHub controls | Enterprise-hosted Actions are active; `CI_RUNNER_LABEL` is unset and no self-hosted runner is registered. Platform and production environments require `@VeVarunSharma` review with `prevent_self_review=true`; development intentionally has no reviewer. Branch, exact-SHA, and CI gates remain mandatory. | Hosted execution and approvals active |
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
| `platform` | Required reviewer `@VeVarunSharma`; `prevent_self_review=true` | `azure-platform.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PLATFORM_RESOURCE_GROUP_NAME`, `FOUNDRY_RESOURCE_NAME`, `PLATFORM_IDENTITY_PRINCIPAL_ID` | none |
| `development` | No required reviewer (intentional); branch/exact-SHA/CI gates remain | `azure-deploy-dev.yml` | Existing deployment values plus `ADMIN_ENTRA_TENANT_ID`, `ADMIN_ENTRA_CLIENT_ID`, `ADMIN_ENTRA_AUDIENCE`, `ADMIN_ENTRA_OPERATOR_ALLOWLIST`, both authentication-context IDs, revocation cutoff, and policy version | Existing independent values plus `ADMIN_ENTRA_CLIENT_SECRET`; no admin password/session secret |
| `production-deploy` | Required reviewer `@VeVarunSharma`; `prevent_self_review=true` | `azure-deploy-prod.yml`, release portion of `azure-rotate-secrets.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PROD_RESOURCE_GROUP_NAME`, `PROD_DEPLOY_IDENTITY_NAME`, `PROD_PROMOTION_IDENTITY_NAME` | same names as development, with independent prod values |
| `production-promotion` | Required reviewer `@VeVarunSharma`; `prevent_self_review=true`; forced-disable boundary only | Forced-disable portions of `azure-deploy-prod.yml` and `azure-rotate-secrets.yml` only | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PROD_RESOURCE_GROUP_NAME` | none |

### IAM-01 Microsoft Entra setup and evidence

Before deploying the issue #129 source, create one single-tenant Entra web app
per environment with redirect URI
`https://<container-app-fqdn>/.auth/login/aad/callback`. Define the three exact
app roles from ADR 0015, keep user assignment required, and provide the reviewed
tenant/client/audience and named object-ID allowlist through GitHub Environment
variables. Store only the confidential client value in the protected
`ADMIN_ENTRA_CLIENT_SECRET`; release Bicep writes it to Key Vault and registers a
Key Vault-backed Container App secret that is not exposed to the application
container or ops jobs.

Create distinct Conditional Access authentication contexts for routine MFA and
sensitive step-up. Both require phishing-resistant MFA; sensitive use must
produce `auth_time` within five minutes. Configure Entra sign-in/risk alerts and
the Project Krypto credential-concern incident path. Do not deploy placeholder
IDs, broaden tenant/audience, assign directory-wide application roles, or add a
password fallback.

After deployment, retain target smoke proving anonymous, spoofed platform-header,
password-only, redirect, and HTTP security-header behavior. Separately perform
an attended normal operator flow across every sensitive route and the
two-custodian, time-bounded emergency-account activation/deactivation drill.
Index redacted Entra/PIM/Container Apps/`OperatorAuditEvent` records in issue
#76. Source/CI success is not this live evidence and does not close #129.

### Approval and evidence procedure

- CI runs `npm run deployment:verify-github-environments` against the live
  GitHub API and immutable organization/repository IDs. Platform and production
  mutation jobs fail unless the configured authority is a human
  `@VeVarunSharma` reviewer with `prevent_self_review=true` and
  `can_admins_bypass=false`; bots, applications, teams, unknown users,
  administrator bypass, self-review-capable rules, and unexpected deployment
  branches are denied. Every protected mutation job repeats this live check
  immediately before Azure OIDC login so policy drift after CI cannot authorize
  a mutation.
- GitHub Environment deployment records are authoritative for the human
  reviewer. Do not label `GITHUB_ACTOR` as the approver. The signed
  `deployment-smoke-approved` journal row is a separate machine attestation.
- That attestation binds approval ID; database-binding, mode-mismatch, cron-run,
  and admin-run evidence IDs; target origin; release SHA; image digest;
  immutable-ledger attestation checksum; disabled rollout mode; keyed
  cron-secret binding; and canonical approval timestamp. It expires exactly 24
  hours after
  `approvedAt`; missing or malformed identifiers/fields, future timestamps,
  row mismatches, changes, copies, or concurrently ambiguous evidence are
  rejected. The dev shadow schedule path reruns activation-check in its mutation
  job and validates current-time expiry immediately before monitoring and
  rollout mutations, so a retained report cannot outlive its approval.
- `@VeVarunSharma` owns rollback through the protected forced-disable path. If
  that account requested the run, authorize a distinct audited human reviewer
  before proceeding; never disable self-review prevention. GitHub deployment
  records, retained workflow artifacts, immutable Azure evidence blobs, and the
  #76 evidence index share custody of the redacted record.
`MIGRATION_URL` and `MIGRATOR_DATABASE_PASSWORD` are new secrets required by
[ADR 0011](./decisions/0011-postgresql-trust-boundary-roles.md)'s PostgreSQL
trust-boundary roles (issue [#133](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/133)).
Source support for both environments is implemented; neither environment's
live GitHub Environment secrets have been set to these values yet, and no
live role migration has run — see §13 below.

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
- `DATABASE_URL` uses `krypto_app`; `DIRECT_URL` uses `krypto_owner`;
  `MIGRATION_URL` uses the dedicated least-privilege `krypto_migrator` role
  over a direct (non-pooled) connection. All three target the same private
  server/database with `sslmode=require`. `MIGRATOR_DATABASE_PASSWORD` is
  granted only to `migrate-init`. The credential-bearing `MIGRATION_URL` is
  mounted only on `migrate-init` and the protected `preflight` job; preflight
  opens an explicit read-only transaction.
  See [ADR 0011](./decisions/0011-postgresql-trust-boundary-roles.md).

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

The issue #125 exact release creates the non-trading
`caj-<env>-safety-relay` on a five-minute schedule even while rollout is
disabled and both trading scheduler jobs are Manual. The relay only reads the
append-only incident table and emits a redacted latest-state export/heartbeat.
Its absence/failure is independently alerted. Do not disable it through the
trading-schedule rollback path; "no schedule" below refers to the hourly and
daily trading scheduler jobs, not this monitor.

`environment.bicep` creates an always-enabled scheduled-query alert for
terminal hourly/daily job failures.

`schedule-monitoring.bicep` owns the separate missing-hourly-success rule.
Its dev/prod `.bicepparam` files default to disabled at boundary `0`:

- before hourly becomes `Schedule`, the workflow passes the current UTC Unix
  timestamp, what-ifs and deploys the monitoring template, and verifies the
  enabled state and exact boundary;
- the rule validates the live Log Analytics schema before schedule resources
  change; missing schema blocks activation;
- missing scheduled completion is evaluated from that exact activation
  timestamp against the authoritative SLO in
  `production-readiness-prd.v1.md` §8.1; and
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

## 13. PostgreSQL trust-boundary roles (ADR 0011) and upgrade procedure

**Current status: source implemented; not yet run against live dev/prod.**
[ADR 0011](./decisions/0011-postgresql-trust-boundary-roles.md) defines the
five-role trust boundary required by issue
[#133](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/133)
(`krypto_owner`, `krypto_schema_owner`, `krypto_migrator`, `krypto_scheduler`,
`krypto_runtime`/`krypto_app`) and the dedicated `MIGRATION_URL` connection.
This section is the operator procedure for adopting it against a live
environment; completing it does not itself change `ROLLOUT_MODE`, schedule
state, or any other release behavior described in §6/§7 above.

1. **Pause/confirm.** Verify the target environment schedule is
   `Manual`/disabled. Production currently satisfies this; dev is
   shadow/scheduled and must first use the existing rollback path (§12) to
   become disabled/manual. Do not begin while either target job has an active
   `Schedule` trigger.
2. **Verified backup.** Run `verified-backup` for the current release and
   retain its immutable evidence before any role or ownership change.
3. **Set secrets.** Add `MIGRATION_URL` and `MIGRATOR_DATABASE_PASSWORD` to
   that environment's GitHub Environment secrets (in addition to the existing
   `DIRECT_URL`, `DATABASE_URL`, `RUNTIME_DATABASE_PASSWORD`,
   `POSTGRES_ADMIN_PASSWORD`). Never commit real values.
4. **Deploy source.** Run the existing gated deploy workflow
   (`azure-deploy-dev.yml` / `azure-deploy-prod.yml`) for the release
   containing `drizzle/0008_postgresql_trust_boundaries.sql` and the updated
   `migrate-init` ops job.
5. **Run `migrate-init`.** This performs, in order: idempotent admin
   role/ownership bootstrap over `DIRECT_URL`; the reviewed migration over
   `MIGRATION_URL` as `krypto_migrator`; runtime login bootstrap; and
   idempotent singleton init via an explicit `krypto_migrator` `SET ROLE
   "krypto_schema_owner"`. It never deletes or resets
   `TradeExecution`/`AgentRun`/`AgentJournal`/`AgentState` rows. Download and
   validate its immutable evidence.
6. **Run `preflight`.** Confirm every `trust-boundary-*` check passes (role
   attributes, connection limits, memberships, the migrator's `SET`-only
   boundary, the runtime denial matrix, default privileges, and the
   fail-closed `search_path`). Download and validate its immutable
   evidence.
7. **Run `target-smoke`.** Confirm the application still functions end to end
   against the narrowed runtime role. Download and validate its immutable
   evidence.
8. **Dev first, then prod.** Do not begin the prod upgrade until dev's own
   upgrade evidence (steps 2, 5, 6, 7) has passed.
9. **Preserve rows/history.** Every step above is idempotent and preserves
   existing trading rows and migration history; nothing in this procedure is
   a reset or reseed.
10. **No schedule activation.** This procedure never changes a schedule from
    `Manual`/disabled to `Schedule`. Schedule activation remains the fully
    separate, already-gated procedure in §6 steps 6–10 and §10.
11. **Rollback/credential handling.** A failure at any step, or an unexpected
    `trust-boundary-*` block, is handled exactly like any other failed
    deployment: use the existing rollback job (§12), do not proceed to the
    next environment, and do not retain the partially-applied credentials as
    if the upgrade had succeeded.
12. **Ongoing rotation.** After the initial upgrade, rotate
    `MIGRATOR_DATABASE_PASSWORD` and `RUNTIME_DATABASE_PASSWORD`
    independently using the existing `azure-rotate-secrets.yml` workflow,
    which now re-runs `migrate-init` (reasserting/rotating both credentials)
    before its `target-smoke` re-run, and still leaves the environment
    disabled/manual afterward.

Evidence for issue [#76](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/76)
per environment: a redacted role matrix; a GitHub Environment secret
inventory proving `MIGRATION_URL`/`MIGRATOR_DATABASE_PASSWORD` are absent
from the runtime and scheduler and from `verified-backup`/`target-smoke`/
`activation-check`; the migration attestation from step 5; the denial
transcript from step 6; and the `scripts/test-migrations.sh` fresh-install
and upgrade test transcript. See ADR 0011's Consequences section for the full
list.

## 14. Bounded-runtime release and evidence procedure

**Current status: source implemented; no issue #132 live Azure evidence exists.** Do not relabel the verified earlier foundation, release, provider-smoke, or scheduled-run records as proof of this later contract.

For the first exact release containing ADR 0012:

1. Keep the target disabled/manual and preserve the current-release backup and rollback ordering.
2. Index the exact source ref, merge SHA, protected-main checks, runtime-matrix artifact, migration `0009` hash/inventory, and bounded deadline/provider/readiness fault-test results in issue #76 as **source/CI evidence**.
3. Run `migrate-init` through the ADR 0011 owner/migrator boundary. Migration `0009_bounded_execution.sql` preserves history, adds `ProviderDailyUsage` and the runtime-readable `RuntimeContract` fingerprint, persists immutable `AgentRun.deadlineAt = startedAt + 180 seconds`, and adds a deferred PAPER-only commit fence that rejects a `TradeExecution` without a matching PAPER run or at/after its deadline.
4. Release the exact SHA/digest with web maximum replicas `3`, pool/admission `1`, both scheduler jobs at `replicaRetryLimit=0` and `replicaTimeout=270`, and scheduler HTTP timeout `210 s`. Do not alter the longer manual ops-job timeouts.
5. Require dependency-free `/api/health/live` and bounded `/api/health/ready`. Readiness must finish within four seconds, use runtime `DATABASE_URL` only, make no provider call or mutation, and prove release SHA/image digest, bounded config, PostgreSQL 17/current login and runtime membership/denials/connection limit, schema fingerprint, singleton reconciliation, lease sanity, rollout mode, and admission. Retain only its status and opaque reason codes; never copy protected values into evidence.
6. Exercise delay, retry, `Retry-After`, timeout, pool exhaustion, outage, lock contention, cancellation, daily-budget exhaustion, terminal persistence, owned-lease release/expiry, and PAPER deadline-fence behavior on the exact target. Bind reports to the immutable deployment and target identity.
7. Before activation, the release/operator must reconcile these application ceilings against each contracted provider plan, rate limit, quota, and cost: Coinbase `1,000`, version-pinned Foundry `200`, PostHog `2,000`, ACS `100` requests per UTC day. Lower the configured ceiling if the contract is smaller. Engineering owns application/runtime correctness; release/operator owns plan/quota/cost reconciliation; operator owns budget/deadline/capacity alert response.
8. Index the future target timing, region, capacity, readiness, PostgreSQL runtime identity/timeouts, quota/cost reconciliation, budget-exhaustion, terminal-run, and lease evidence in issue #76 before any new shadow/PAPER decision.

Provider or capacity exhaustion is a persisted no-trade failure and operator alert, never a trade fallback. This procedure is PAPER-only and creates no production promotion or live-money authorization.

## 15. OPS-01 incident/outbox and alert-evidence procedure

**Current status: no issue #125 live Azure evidence exists; source/CI status
must be classified separately from future target proof.** Follow
[ADR 0013](./decisions/0013-durable-safety-incidents-and-independent-alerts.md)
and [`incident-response.md`](./incident-response.md). Numeric targets come only
from `production-readiness-prd.v1.md` §8.1.

For the first exact release implementing OPS-01:

1. Keep the target disabled/manual with no queued work. Preserve the current
   release, backup, rollback, and PR #224 / PR #228 branch, exact-SHA, CI,
   protected-environment, and reviewer controls; this procedure grants no Azure
   mutation or promotion authority.
2. Index the source ref, merge SHA, protected-main checks, ADR/runbook/SLI-SLO
   versions, migration hashes, append-only/atomicity tests, relay/dedup/retry
   tests, and correlation/redaction tests in issue #76 as **source/CI evidence**.
3. Through a separately approved exact-release path, prove incident origins,
   lifecycle events, outbox obligations, and delivery attempts are append-only;
   prove a safety state change and its incident/outbox commit atomically; and
   prove every PAPER execution commits its post-commit obligation with ledger
   truth.
4. Prove the least-privilege relay is operationally separate from the web
   process. Configure external Azure rules over Log Analytics/platform signals
   and redacted durable database incident/outbox exports. A liveness response
   must not satisfy these rules.
5. Export the exact monitor definitions and target bindings. Test deduplication,
   provider failure, pending outbox age, `journalWritten=false`, persisted
   post-commit failure, and loss of telemetry without changing paper state or
   returning a success-shaped fallback.
6. Populate and verify the fail-closed roster in issue #76. Any missing,
   placeholder, unavailable, untested, contradictory, or stale primary on-call,
   backup on-call, release owner, trading-safety approver, evidence custodian,
   or rollback owner blocks issue #75 / PR-G2.
7. Test-fire non-trading warning and critical incidents through persistence,
   relay, independent observation, delivery, acknowledgment, escalation,
   containment, recovery, and explicit resolution. Prove a retry never
   auto-resolves the original incident.
8. Run the production-equivalent non-trading game day required by
   `incident-response.md`, preserving ledger truth and proving zero unexpected
   trade delta.
9. Index redacted monitor exports, outbox/delivery evidence, provider receipts,
   drill/game-day timelines, acknowledgments, escalations, roster,
   correlation/redaction review, preserved-ledger/reconciliation evidence, and
   follow-ups in issue #76 as **future exact-release target evidence**.

This documentation/source change does not claim that the incident schema,
relay, Azure rules, Action Group delivery, roster, drills, or game day are live.
Production remains disabled/manual, and no live-money procedure exists.

## 16. ACCT-01 immutable-ledger attestation procedure

1. Keep the exact target disabled/manual. Run `ledger:attest --purpose
   preflight` through the ops image or the integrated deployment preflight.
   Retain the redacted report; do not pass credentials in arguments.
2. Require schema `1.0.0`, status `PASS`, the 10,000-row bound, runtime role
   `krypto_runtime`, and exact release SHA/image/config/database identity
   binding. Compare the report checksum with the signed target-smoke approval.
3. After the declared shadow observation and immediately before any PAPER
   decision, rerun through activation-check with purpose `pre-paper`. Only
   `anchorDecision=RETAIN` and `paperPromotionEligible=true` pass. A missing,
   stale, future, malformed, or config-mismatched anchor blocks.
4. Do not reset, reseed, edit, delete, or fabricate ledger/anchor history. If a
   failed report must be contained, a separately approved operator may run
   `ledger:quarantine --report <failed-report>` through `MIGRATION_URL`. Verify
   the checksum against a fresh read-only replay of the bound `DIRECT_URL`; the
   operation must set/retain `QUARANTINED` and append one deduplicated critical
   incident.
5. Re-run attestation after investigation only as recovery evidence. A later
   pass does not auto-resolve the incident or authorize promotion.
6. Index the exact source/CI and future target artifacts listed in
   `readiness.md` under ACCT-01 in issue #76.

This procedure performs no Azure mutation by itself, does not activate PAPER,
and provides no live-money path.

## Further reading

- [`../infra/README.md`](../infra/README.md) — template, identity, secret,
  monitoring, and limitation detail.
- [`architecture.md`](./architecture.md) — topology, planned names, and live
  endpoint register.
- [`readiness.md`](./readiness.md) — current evidence and promotion gates.
- [`monitoring.md`](./monitoring.md) — operational alerts and reviews.
- [`incident-response.md`](./incident-response.md) — incident roles, response,
  drills, and evidence.
- [`decisions/0008-azure-native-deployment-architecture.md`](./decisions/0008-azure-native-deployment-architecture.md)
  — accepted Azure architecture.
- [`decisions/0011-postgresql-trust-boundary-roles.md`](./decisions/0011-postgresql-trust-boundary-roles.md)
  — PostgreSQL owner/schema-owner/migrator/scheduler/runtime trust boundary.
- [`decisions/0013-durable-safety-incidents-and-independent-alerts.md`](./decisions/0013-durable-safety-incidents-and-independent-alerts.md)
  — append-only incidents/outbox and independent external alerts.
- [`decisions/0014-deterministic-ledger-attestation.md`](./decisions/0014-deterministic-ledger-attestation.md)
  — exact read-only replay, anchor decision, and protected quarantine.
