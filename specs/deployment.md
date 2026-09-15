# Deployment runbook (Azure)

> **Historical checkpoint (2026-08-15): both Azure releases deployed.** Dev was
> `shadow` with monitored hourly/daily schedules. Production is `disabled`
> with all jobs `Manual`. Migration, provider/email/admin target smoke,
> restore-verified production backup, alert delivery, and exact-digest checks
> passed. No production promotion is shipped or authorized.
>
> **Recovery checkpoint (2026-09-15): current dev health is unverified.**
> The latest retained main deployment, run `32749930667` for
> `451d0eabc413cd1222938f399269435f8265290e`, failed at target-smoke after
> applying disabled/Manual. Shadow staging and scheduling were skipped.
> Historical success is not current development evidence; see the recovery
> handoff below. Production was not inspected or changed during recovery.
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
| Runtime model config | `AZURE_OPENAI_BASE_URL` ending `/openai/v1`, `AZURE_OPENAI_DEPLOYMENT_NAME`, `AZURE_CLIENT_ID` |
| Email | Per-environment ACS Email with Azure-managed domain |
| Analytics | Every event carries mandatory `deployment_environment`; a distinct dev project remains required before production promotion |

The rejected candidate region `eastus2` is a **historical constraint, not a
target**: the selected subscription is restricted from PostgreSQL
provisioning there. All current templates and commands use `westus3`.

Do not commit or publish the subscription ID, tenant ID, identity IDs, full
Azure resource IDs, database URLs, Key Vault URLs, evidence URLs, or other
internal deployment identifiers. Protected workflow variables may carry
those values without making them public documentation.

### Historical live checkpoint (2026-08-15)

| Stage | Live state | Evidence |
|---|---|---|
| Providers/bootstrap | Required providers are registered; platform/dev/prod resource groups and four GitHub OIDC identities exist | Complete |
| GitHub controls | Environments, branch restrictions, variables, and release secrets are configured. `production-deploy`, `production-promotion`, `platform`, and `development-promotion` carry human required-reviewer protection (verified via the GitHub API); `development` carries only a branch policy and is the sole environment the factory mutates automatically, behind branch, exact-SHA, and CI gates. | Live; reviewer enforcement active on human-gated environments |
| Foundry platform | Dedicated account remains model-empty after `715-123420`; fallback dev/prod Luna deployments on `ghcp-foundry-eastus2` succeeded and passed Entra plain/structured smokes. | Operational fallback complete |
| Workload access | Dev/prod runtime and ops identities have Cognitive Services OpenAI User on the operational account | Complete |
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
- one subscription-scoped, read-only **Cognitive Services Usages Reader**
  assignment for `id-github-oidc-platform`.

Record the deployment outputs in a protected operator handoff. Client and
principal IDs are configuration inputs, not documentation values.

## 2. GitHub Environments and current gates

**Current status (verified via the GitHub API): five configured Environments,
one autonomous.** `production-deploy`, `production-promotion`, `platform`,
and `development-promotion` each carry a human required reviewer
(`prevent_self_review` enabled on `production-deploy`/`production-promotion`/
`platform`) plus a branch policy. `development` carries only a branch
policy — no required reviewer — and is the only environment the factory may
mutate autonomously; it is gated instead by the configured branch, an exact
40-hex commit SHA, and successful push-triggered CI (see §3). `development`,
`platform`, `production-deploy`, and `production-promotion` all have a
branch policy allowing both `develop/azure` and `main` (`main` was added to
`development` to match the automatic `workflow_run`-triggered dev deploy in
§3, which always resolves the exact head SHA of a passing `main` push-CI
run; the same `main` policy on the human-gated environments simply lets a
human dispatch those workflows from `main` too, it does not change their
required-reviewer gate). `development-promotion` is the one environment
still restricted to `develop/azure` only, and it is not referenced by any
deployment workflow — this is further confirmation that it is reserved, not
wired into the automatic `main` dev-deploy path. A `copilot`
environment also exists with no protection rules and is not used by any
deployment workflow. Do not weaken any required-reviewer environment's
protection rules, and do not claim an executable "production promotion"
path exists: `production-promotion` remains identity/environment scope for
forced-disable and rotation steps only.

Environments, branch restrictions, and protected variables/secrets are
configured for all of the following.

| Environment | Workflows | Required variables | Required secrets | Branch policy |
|---|---|---|---|---|
| `platform` | `azure-platform.yml`, `azure-platform-access.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PLATFORM_RESOURCE_GROUP_NAME`, `FOUNDRY_RESOURCE_NAME`, `PLATFORM_IDENTITY_PRINCIPAL_ID` | none | `develop/azure`, `main` |
| `development` | `azure-deploy-dev.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `DEV_RESOURCE_GROUP_NAME`, `DEV_IDENTITY_NAME` | `POSTGRES_ADMIN_PASSWORD`, `DATABASE_URL`, `DIRECT_URL`, `CRON_SECRET`, `POSTHOG_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `RUNTIME_DATABASE_PASSWORD`, `DEPLOYMENT_APPROVAL_SECRET` | `develop/azure`, `main` |
| `production-deploy` | `azure-deploy-prod.yml`, release portion of `azure-rotate-secrets.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PROD_RESOURCE_GROUP_NAME`, `PROD_DEPLOY_IDENTITY_NAME`, `PROD_PROMOTION_IDENTITY_NAME` | same names as development, with independent prod values | `develop/azure`, `main` |
| `production-promotion` | Forced-disable portions of `azure-deploy-prod.yml` and `azure-rotate-secrets.yml` only | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PROD_RESOURCE_GROUP_NAME` | none | `develop/azure`, `main` |
| `development-promotion` | None (reserved; not referenced by any workflow) | — | — | `develop/azure` only |

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
structured `HOLD` smokes. Keep the dedicated account for a future migration.

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

`azure-deploy-dev.yml` accepts an automatic `workflow_run` trigger — gated on
`github.event.workflow_run.event == 'push' && conclusion == 'success' &&
head_branch == 'main'`, and always checking out that CI run's exact head SHA
— which always resolves to the `full` deployment stage, plus a
`workflow_dispatch` escape hatch (`commit_sha`, `deployment_stage`) for a
manual foundation-only run. `azure-deploy-prod.yml` remains
`workflow_dispatch`-only with the same two inputs and has no `workflow_run`
trigger. Manual SHAs must be ancestors of the configured target branch and
have their own successful push-triggered CI run.

### Automatic dev deploy and evidence

GitHub evaluates a `workflow_run` trigger using the workflow file from the
repository's default branch, so `azure-deploy-dev.yml` runs automatically
after every successful push-triggered `CI` run on `main`, deploying the
exact SHA CI validated — no separate manual step is required for `development`,
because that environment carries only a branch policy and no human required
reviewer. The run publishes a `Dev deployment evidence` commit status and a
GitHub Deployment (`task: "dev-evidence"`, `environment: "development"`,
`transient_environment: true`, `production_environment: false`) on that SHA.
A pending authoritative record is written before a full release mutates
development, so an interrupted attempt cannot inherit an old success.
The latest Deployment and its latest status are authoritative, never any
historical successful status or GitHub environment-wrapper job.
The workflow structurally
verifies rollback: any promotion-stage failure after a successful deploy
triggers a fail-closed rollback path whose outcome is recorded in the same
evidence. This mechanism has not yet been exercised by an actual production
incident; treat "structurally verifies rollback on failure" and "a rollback
has been observed in production" as two different claims. Production has no
automatic trigger and must be dispatched manually with an explicit
`commit_sha` at each stage, behind its required-reviewer environments.

The final verification job assembles `dev-deployment-proof.json` from the
original downloaded operation reports and the exact live rollout receipt.
Its immutable Actions artifact is named
`azure-deploy-dev-proof-<sha>-a<attempt>`; the authoritative Deployment
payload binds its ID, name, ZIP SHA-256, release SHA, web/ops digests, and
workflow run/attempt. This payload is a version-1 receipt, not a replacement
for the existing operation report schemas. An unreadable, expired,
incomplete, or mismatched artifact is never a pass. Proof validation and
upload happen inside final verification, before the rollback decision.

Lifecycle and full-cycle canary verification share
`.github/scripts/azure/dev-evidence.cjs`:
`readDevEvidence({github, owner, repo, sha, pullNumber})` returns
`{outcome, reason, receipt?}`. It verifies the latest authoritative statuses,
the successful same-repository `main` Azure dev workflow and exact attempt,
the immutable artifact bytes, each operation report and its path/hash, and
the current SHA/digest-bound shadow/Schedule proof. It rereads statuses
before accepting. `evaluateDevEvidence` remains a status-only compatibility
API and is **not** report validation.

The receipt contains `schemaVersion: 1`, `environmentName: "dev"`,
`releaseSha`, `imageDigest`, `opsImageDigest`, `workflowRunId`,
`workflowRunAttempt`, `deploymentId`, `commitStatusId`, `deploymentStatusId`,
`artifact: {id, name, digest}`, and `reports: [{operation, path, sha256}]`.
Collectors must report unavailable/unverified when the reader is not yet
deployed, rather than fall back to green statuses. Actual read failures
remain errors. Lifecycle passes separately record merged, deployed-dev,
and done; the done pass revalidates current evidence before closure. The
six-hour missing-evidence deadline is unchanged.

### Recovery operator handoff (2026-09-15)

[Run 32749930667](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/32749930667)
records target execution `caj-dev-target-smoke-nprgqgd` as Failed at
`2026-08-24T16:33:09Z`. Artifact `9529167024` contains passing migrate-init
and preflight reports only. The original workflow stopped before downloading
the target-smoke failure report. Shadow staging, activation, Schedule,
final verification, and rollback were skipped; a successful publisher job
does not change the failed deployment outcome.

The recovery session's existing Azure CLI identity could not retrieve
`dev/451d0eabc413cd1222938f399269435f8265290e/target-smoke/run32749930667-a1-target-smoke/report.json`:
the evidence storage endpoint returned `AccountIsDisabled`. The approved
subscription display name was absent from `az account list --all`; explicit
storage-management and Log Analytics reads against it returned
`Subscription not found`. This proves a scoped evidence-access blocker,
**not** a disabled subscription or a Foundry IAM root cause. The previously
reported Foundry `PermissionDenied` diagnosis remains unverified.

An authorized human must use an attended session for the approved
tenant/subscription, privately resolve the evidence account/container and
identities from foundation artifact `9528713527`, and retrieve that exact
blob plus the target execution's `2026-08-24T16:32:00Z` to `16:34:00Z` logs.
Inspect the account-disabled condition through the approved management
scope before taking any account action. If the recovered report instead
proves model authorization failure, compare the target-smoke job's actual
Entra client identity and the configured model account with live role
assignments; only a human may apply a proven, reviewed account-scoped access
correction. Do not substitute an API key, another model/account, broad
roles, or a deployment for diagnosis.

No production action, account/context change, IAM grant, secret change,
factory activation, live canary, or dev deployment was performed in this
recovery. A newly successful exact-SHA full dev run and retained immutable
proof are still required; Copilot model availability and local tests cannot
establish Azure runtime health.

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

**Historical status: verified on 2026-08-15.** Dev/prod runtime and ops
identities each had one Cognitive Services OpenAI User assignment. Current
assignments are not reverified by the recovery checkpoint above. Neither
historical access nor an existing model deployment makes a release ready.

Run `azure-platform-access.yml` only after both foundation artifacts exist.
Supply exactly the retained principal IDs for:

- dev runtime;
- dev ops;
- prod runtime; and
- prod ops.

The workflow format-validates them, runs an environment-scoped what-if job,
publishes the what-if artifact, then runs a separate apply job. The operational fallback has exactly one **Cognitive Services OpenAI User**
assignment per runtime/ops principal at the established account scope.
Scheduler identities receive no Foundry role.

Do not proceed to a full release until the live assignment verification
passes. This is the dependency bridge between the application foundations and
keyless model access.

## 6. Dev full release and schedule activation

**Recovery status: blocked at target-smoke; automatic trigger remains
configured.** The original manual `full` run established shadow/Schedule,
but the later failed main deployment supersedes that evidence. Current
healthy shadow/Schedule must not be claimed without a fresh successful
exact-SHA proof. The workflow remains triggered by passing push CI on
`main`; this recovery does not dispatch it or change its authority.

The implemented order is:

1. **Gate** the exact SHA and `full` stage.
2. **Environment** what-if/apply and publish the current foundation handoff.
3. **Build** web and ops images and resolve immutable digests.
4. **Release** what-if/apply. `release.bicep` hardcodes
   `ROLLOUT_MODE=disabled` and both scheduler jobs to `Manual`.
5. **Disabled evidence** — run `migrate-init`, `preflight`, and
   `target-smoke`; download and independently validate every immutable
   report. Changes matching the canonical policy's `isMigrationFile`
   predicate also require a restore-verified `verified-backup` report.
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

Development uses `run-ops-with-evidence.sh` to attempt the exact report
download even after the operation returns failure. Retention is bounded to
120 seconds (plus a 10-second termination grace); missing or unreadable
reports are explicit errors. If both execution and retention fail, the
original execution exit code is preserved. Neither a retained failure
report nor a verified rollback turns the original operation into success.
Attempt-specific artifact names prevent older same-run artifacts from
satisfying a retry.

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
