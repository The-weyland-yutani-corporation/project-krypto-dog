# Project Krypto Azure infrastructure (Bicep)

This tree implements the Azure-native target accepted by
[`specs/governance.md`](../specs/governance.md).

> **Recovery configuration, not deployment proof (2026-10-21).** The owner
> selected a new subscription for both development and production. The
> recovery parameter files use a new `02` resource namespace and the current
> GitHub organization identity. No new-target provisioning or permission
> changes are approved by these files.
>
> **Paper only.** Templates support `disabled`, `shadow`, and `paper`.
> Nothing provisions or authorizes live-money execution.

**Historical checkpoint, not a current environment attestation.** The dates and
live-state tables below record the 2026-08-15 provisioning work. Previous README and
infrastructure notes conflicted on required-reviewer enforcement. Its current
state must be checked against the environments actually referenced by each
workflow, with dated evidence before any deployment.
Do not infer approval from workflow YAML, a configured reviewer name, or a past
successful run. Unknown enforcement blocks deployment; it never authorizes
removing or bypassing a protection.

## Recovery target contract

- Runtime-selected subscription: the owner's newly selected target, not
  the historical Visual Studio Enterprise subscription. Its ID and
  internal identifiers must remain in private/protected settings.
- Region: `westus3`.
- Resource groups: `rg-krypto-platform`, `rg-krypto-dev`,
  `rg-krypto-prod`.
- Dedicated Foundry account: `ai-krypto-westus3-02`. Account creation, its
  returned endpoint, account-specific model availability, and Entra smokes
  must be verified before application release. Do not reuse the historical
  `ghcp-foundry-eastus2` fallback across tenants.
- Development/production name prefixes: `krypto-dev02` / `krypto-prod02`.
  Registry, vault, storage, and communication names are in the corresponding
  `environment.*.bicepparam` files. Production deployment and secret-rotation
  workflow constants must match those files; regression tests enforce this.
- Model: OpenAI `gpt-5.6-luna`, version `2026-07-09`,
  `GlobalStandard`.
- Deployments: `krypto-dev-luna` and `krypto-prod-luna`, capacity 10 each.
- Runtime/ops callers use Microsoft Entra ID and only **Cognitive Services
  OpenAI User**. Project Krypto does not mount model API keys.
- Email is per-environment Azure Communication Services Email with an
  Azure-managed domain.
- Every event is tagged with `deployment_environment`; separate PostHog
  projects remain required before production promotion.

The owner retained `westus3`. Historical region restrictions from the previous
subscription do not establish capabilities in the new target.

The $500/month Azure planning ceiling is not a hard spending cap. See
[the recovery plan](../.azure/deployment-plan.md) for observed capacity,
cost assumptions, outstanding prerequisites, and approval boundaries.

## Historical provisioning checkpoint (2026-08-15)

| Surface | Live state | Evidence |
|---|---|---|
| Subscription/bootstrap | Required providers registered; three resource groups and four GitHub OIDC identities exist | Bootstrap complete |
| GitHub controls | Historical notes disagree on required-reviewer enforcement | Superseded by the dated configuration observation in [OIDC boundaries](#github-oidc-identities-and-process-boundaries); protected values and live admission still require verification |
| Foundry accounts | Dedicated `ai-krypto-westus3` remains model-empty after `715-123420`; operational dev/prod Luna deployments on `ghcp-foundry-eastus2` succeeded and passed Entra smokes | Fallback active |
| Foundry workload access | Dev/prod runtime and ops identities each have Cognitive Services OpenAI User on the operational account | Applied |
| Dev foundation | ACR, private PostgreSQL 17, Key Vault, evidence storage, Container Apps environment, ACS Email managed domain, Log Analytics/alerts, and workload identities exist | [Foundation passed](https://github.com/VeVarunSharma/project-krypto-dog/actions/runs/31841581875) |
| Prod foundation | Same foundation resource classes exist with production controls | [Foundation passed](https://github.com/VeVarunSharma/project-krypto-dog/actions/runs/31841960745) |
| Releases | Dev/prod web Container Apps and scheduler/ops jobs are deployed; dev completed target-smoke and scheduled-run evidence; production remains disabled/manual | Deployed with safety state |
| Analytics | Shared ingestion key temporarily staged with mandatory dev/prod event tags; separate projects remain a promotion gate | Release-testable |

Azure Support API ticket creation for the dedicated account failed because the
subscription has no eligible support plan. The established account removed that historical release blocker. That does
not establish access or model availability for the newly selected target.

## Subscription prerequisite

Before any `bootstrap.bicep` what-if, an authorized subscription owner must
run:

```bash
.github/scripts/azure/register-providers.sh
```

The script registers the reviewed Azure provider list, waits for every
namespace to reach `Registered`, and fails otherwise. Platform/dev/prod
deployment workflows call it with `--check-only`; workflow identities cannot
register providers or mutate subscription provider state. The reviewed list
includes `Microsoft.Network` for the VNet/private-networking foundation.

## Layout

```text
infra/
  bootstrap.bicep          subscription scope: three RGs, four OIDC identities, minimal read-only roles
  platform-account.bicep   rg-krypto-platform: dedicated Foundry account + delete lock
  platform.bicep           rg-krypto-platform: pinned dev/prod Luna deployments
  platform-access.bicep    rg-krypto-platform: runtime/ops inference role bindings
  environment.bicep        per environment: foundation resources and identities
  release.bicep            per environment: disabled/manual app, jobs, and Key Vault secrets
  rollout.bicep            per environment: rollout mode and job trigger state
  schedule-monitoring.bicep per environment: missing-hourly-success alert state/boundary
  modules/                 reusable resource modules
  params/                  nonsecret reviewed .bicepparam files
```

## Template ownership

| Template | Owns | Must not do |
|---|---|---|
| `bootstrap.bicep` | Platform/dev/prod resource groups; four OIDC identities and RG roles; one-action provider-state reader role/assignments; platform **Cognitive Services Usages Reader** | Other subscription permissions, application resources, model deployments, secrets |
| `platform-account.bicep` | Dedicated Foundry account and `CanNotDelete` lock | Model deployments or workload access |
| `platform.bicep` | Exact dev/prod model deployments and platform smoke role | Account lifecycle or application identities |
| `platform-access.bicep` | Four account-scoped workload role assignments | Model/account mutation |
| `environment.bicep` | Network, ACR, Container Apps environment, PostgreSQL, Key Vault, evidence storage, ACS Email, Log Analytics, Action Group/failed-job alert, runtime/scheduler/ops identities, and prod PostgreSQL/Key Vault/storage delete locks | App release, schedule activation, application secret payloads |
| `release.bicep` | Web app, scheduler jobs, five ops jobs, application Key Vault secrets/RBAC | Any schedule; it hardcodes disabled/manual |
| `rollout.bicep` | Web rollout mode and scheduler trigger state | Monitoring, new images, Key Vault values, role assignments, ops-job definitions |
| `schedule-monitoring.bicep` | Schedule-bound missing-hourly-success alert and activation timestamp | Web mode, job trigger state, release resources |

This separation is operationally important. Foundations are deployable before
Foundry workload access exists; releases are not.

## GitHub OIDC identities and process boundaries

`bootstrap.bicep` creates four user-assigned identities:

| Identity | GitHub Environment | Resource-group roles | Subscription read-only roles | Intended templates |
|---|---|---|---|---|
| `id-github-oidc-platform` | `platform` | `rg-krypto-platform`: Contributor, Role Based Access Control Administrator, Locks Contributor | **Project Krypto Provider Registration Reader**; **Cognitive Services Usages Reader** | `platform-account.bicep`, `platform.bicep`, `platform-access.bicep` |
| `id-github-oidc-dev` | `development` | `rg-krypto-dev`: Contributor, Role Based Access Control Administrator | **Project Krypto Provider Registration Reader** | `environment.bicep`, `release.bicep`, `rollout.bicep`, `schedule-monitoring.bicep` |
| `id-github-oidc-prod-deploy` | `production-deploy` | `rg-krypto-prod`: Contributor, Role Based Access Control Administrator, Locks Contributor | **Project Krypto Provider Registration Reader** | `environment.bicep`, `release.bicep` |
| `id-github-oidc-prod-promotion` | `production-promotion` | `rg-krypto-prod`: Contributor | none | Forced-disable jobs in prod deploy/rotation only: `rollout.bicep`, then `schedule-monitoring.bicep` |

The custom **Project Krypto Provider Registration Reader** contains exactly
`Microsoft.Resources/subscriptions/providers/read`. It is assigned at
subscription scope only to the platform, dev, and prod-deploy identities so
their workflow `--check-only` steps can inspect provider state without broad
Reader. It cannot register providers; the prod-promotion identity does not
receive it.

Azure enforces resource-group scope, not the intended template list. A
resource-group Contributor can deploy other resources in that group.
Template separation therefore also depends on protected workflow files,
GitHub Environment reviewers, branch rules, and CODEOWNERS. On 2026-10-21,
the live Environment API reported branch restrictions for `development`,
and branch restrictions plus required reviewers and `prevent_self_review`
for `platform`, `production-deploy`, and `production-promotion`. All permit
only `main` and `develop/azure`. These are configuration observations, not a
successful deployment attestation. Preserve those protections; a chat
approval or a green local build does not bypass them. Fully unattended
production delivery still needs an explicitly approved protection design.

No executable production promotion workflow is shipped or approved. The
`production-promotion` name denotes the separately reviewed forced-disable
boundary used only by `azure-deploy-prod.yml` and
`azure-rotate-secrets.yml`; it is not an available activation path. Any
future production promotion requires a new evidence-bound design and review.

The platform, dev, and prod-deploy identities can create their reviewed role
assignments and therefore have Role Based Access Control Administrator at
their own resource-group scope. The platform identity has Locks Contributor in
`rg-krypto-platform` for the Foundry account lock. The prod-deploy identity has
Locks Contributor in `rg-krypto-prod` because `environment.bicep` creates the
prod PostgreSQL, Key Vault, and evidence-storage locks. Role Based Access
Control Administrator is powerful within those resource groups; it is not a
role-assignment allow-list. Honor each workflow's configured Environment,
branch restrictions, reviewers, and current-head evidence gates. Automation
must not silently remove a configured review requirement.

All mutation permissions remain resource-group-scoped. Subscription scope is
read-only: the minimal provider-state role above, plus **Cognitive Services
Usages Reader** on the platform identity for live regional quota inspection.
Neither grants provider registration or any other subscription mutation.

No long-lived Azure service-principal credential is stored in GitHub.

## Dedicated Foundry platform

### Account lifecycle

`platform-account.bicep`, using the recovery parameter file, creates
`ai-krypto-westus3-02` as
`Microsoft.CognitiveServices/accounts`:

- kind `AIServices`, SKU `S0`;
- region `westus3`;
- `disableLocalAuth: true`;
- public data-plane network access, with authorization still Entra-only; and
- `CanNotDelete` lock `protect-foundry-account`.

The account is Bicep-managed in `rg-krypto-platform`; it is not a pre-existing
external dependency and is not placed in either application resource group.

### Model deployments and quota

`platform.bicep` pins every model field with single-value `@allowed` guards:

| Field | Dev | Prod |
|---|---|---|
| Deployment | `krypto-dev-luna` | `krypto-prod-luna` |
| Format | `OpenAI` | `OpenAI` |
| Model | `gpt-5.6-luna` | `gpt-5.6-luna` |
| Version | `2026-07-09` | `2026-07-09` |
| SKU | `GlobalStandard` | `GlobalStandard` |
| Capacity | 10 | 10 |
| Version upgrade | `NoAutoUpgrade` | `NoAutoUpgrade` |

`.github/scripts/azure/validate-model-quota.sh` requires:

1. exactly one catalog match for all four model/SKU fields;
2. a nonempty exact catalog `usageName`;
3. exactly one quota record whose `name.value` equals that `usageName`;
4. valid integer current/limit values;
5. every per-deployment request within any catalog maximum;
6. both target deployment-name/capacity pairs; and
7. available quota at least the incremental requirement:
   `max(20 - exact replaceable target capacity, 0)`.

Replaceable capacity is counted only for the two exact target names when their
format, model, version, and SKU match the validated dimension. Unrelated
deployments and same-name deployments on a different dimension are never
subtracted. This makes an exact rerun idempotent without weakening aggregate
quota validation. The script never substring-matches, takes a first match, or
invents a fallback.

### Keyless access

`platform.bicep` grants the protected platform smoke principal
**Cognitive Services OpenAI User** for attended no-trade verification.
`platform-access.bicep` independently grants the same one role at account
scope to:

- dev runtime;
- dev ops;
- prod runtime; and
- prod ops.

Schedulers invoke the application and receive no direct Foundry access.
Runtime configuration is:

```text
AZURE_OPENAI_BASE_URL=<protected account endpoint ending /openai/v1>
AZURE_OPENAI_DEPLOYMENT_NAME=krypto-dev-luna | krypto-prod-luna
AZURE_CLIENT_ID=<matching runtime-or-ops UAMI client ID>
```

There is no model API key or dated runtime API-version setting.

## Per-environment foundation

`environment.bicep` creates, in `westus3` unless the Azure resource itself is
global:

- VNet and delegated private PostgreSQL subnet/private DNS;
- environment-specific ACR;
- Log Analytics workspace;
- Container Apps managed environment;
- PostgreSQL Flexible Server 17;
- Key Vault;
- immutable evidence storage/container;
- runtime, scheduler, and ops UAMIs;
- ACS Communication Service, Email Communication Service, and Azure-managed
  email domain; and
- Action Group plus terminal scheduler-job failure alert.

Planned communication names are:

| Environment | Communication Service | Email Communication Service |
|---|---|---|
| dev | `acs-krypto-dev02` | `email-krypto-dev02` |
| prod | `acs-krypto-prod02` | `email-krypto-prod02` |

The Azure-managed sender is an `environment.bicep` output. No custom DNS is
required.

## Deployment order and foundation handoff

1. Inspect provider registrations in the explicitly selected subscription;
   register missing providers only with approval. All required providers
   were already registered during the recovery assessment.
2. Validate and approve the exact new-target `bootstrap.bicep` effects,
   then provision the three resource groups and four scoped OIDC identities.
   Do not rebind protected GitHub settings to unverified identity outputs.
3. Provision `platform-account.bicep`, then the exact Luna deployment pair
   and Entra no-trade smokes through the protected `azure-platform.yml`
   path. Verify the returned endpoint against the release/rollout inputs.
4. `azure-deploy-dev.yml` with `deployment_stage=foundation`.
5. `azure-deploy-prod.yml` with `deployment_stage=foundation`.
6. Environment-scoped manual `azure-platform-access.yml` with the four retained
   runtime/ops principal IDs.
7. Full dev release and monitored shadow activation.
8. Full prod release, ending disabled/manual. No production promotion
   workflow is shipped or approved.

New-target checkpoint: preparation only. The historical assertion that all
eight steps completed is not evidence for this subscription. A foundation-only
workflow success is not an application release or full factory canary.

Both foundation workflows publish a nonsecret handoff artifact containing
identity IDs, evidence metadata, ACS sender, and monitoring IDs. The access
workflow consumes the principal IDs through explicit reviewed inputs; it
does not guess them.

Manual workflows support `foundation` and `full`; the workflow definition maps
`workflow_run` events to `full` for development. Production remains manual-only
and disabled/Manual. The development workflow uses the `development`
Environment, not the legacy `development-promotion` Environment; inspect the
protections actually referenced by each workflow. Any approved dispatch must
use the configured branch, exact CI-passed SHA, and existing CI gate.

Both production stages require dispatch from protected `main` and successful
main push CI for the exact candidate SHA. The verifier refreshes the exact
remote-tracking branch and independently checks each returned run's SHA,
branch, event, terminal status, and successful conclusion; another branch's
success does not authorize production. Production `foundation` is only for
an environment without an application release; it rejects a complete existing
release and partial release inventory. Existing releases use `full` and the
owned cutover protocol below.

## Release secrets and Azure-generated values

`release.bicep` accepts these protected deploy-time values:

```text
DATABASE_URL
DIRECT_URL
CRON_SECRET
POSTHOG_API_KEY
ADMIN_PASSWORD
ADMIN_SESSION_SECRET
RUNTIME_DATABASE_PASSWORD
DEPLOYMENT_APPROVAL_SECRET
```

`environment.bicep` separately accepts `POSTGRES_ADMIN_PASSWORD`.

For an existing production release, `postgresCredentialMode=preserve` uses
the PostgreSQL resource's
[update-only mode](https://learn.microsoft.com/azure/templates/microsoft.dbforpostgresql/2024-08-01/flexibleservers)
and omits `administratorLoginPassword` from the resource update. Infrastructure
remains managed, but its deployment cannot invalidate the versioned `DIRECT_URL`
used by source-image ops jobs between cutover checks. The committed production
parameters default to `preserve`; only the workflow's explicit fresh-release
path selects `initialize`. Missing or malformed inventory fails closed.

Database credential rotation is not part of a normal production upgrade.
Protected database secrets must still match the database when the new release
is installed. `azure-rotate-secrets.yml` redeploys Key Vault/release bindings;
it does not rotate the PostgreSQL administrator password or database-side
runtime role password. Such rotation needs a separately coordinated procedure,
not an incidental password update halfway through an owned cutover.

Dev and prod use independent safety/auth values. The temporary PostHog
shared-key fallback is allowed only because `POSTHOG_ENVIRONMENT` is mandatory
and attached to every event; separate projects remain required before
production promotion. All corresponding `.bicepparam` calls use
`readEnvironmentVariable()` with no fallback, so missing values fail closed.

ACS is intentionally different:

1. `environment.bicep` creates the environment's Communication Service.
2. `release.bicep` calls `communicationService.listKeys()`.
3. The returned primary connection string is written directly to the
   environment Key Vault secret `azure-communication-connection-string`.
4. The runtime resolves that secret through its UAMI.

The ACS connection string is never a GitHub variable, secret, workflow input,
artifact, or committed parameter. The sender and recipient are nonsecret
runtime settings:

```text
AZURE_COMMUNICATION_EMAIL_SENDER
ALERT_EMAIL_TO
```

## Application identity and Key Vault matrix

Every Key Vault role assignment is **Key Vault Secrets User** scoped to one
secret resource, not the whole vault.

| Identity | Workload | Secret access | Other access |
|---|---|---|---|
| runtime | Web Container App | `database-url`, `cron-secret`, `posthog-api-key`, `azure-communication-connection-string`, `admin-password`, `admin-session-secret` | ACR pull; Foundry OpenAI User |
| scheduler | Hourly and daily jobs | `cron-secret` only | ACR pull; no Foundry role |
| ops | Five manual jobs | Union of `database-url`, `direct-url`, `cron-secret`, `admin-password`, `posthog-api-key`, `runtime-database-password`, `deployment-approval-secret` | ACR pull; evidence-container writer; Foundry OpenAI User |

The ops identity never receives the ACS connection string or admin session
secret. Target smoke validates ACS by asking the running app to send and
persist a daily-summary delivery; the runtime, not the ops process, holds the
ACS secret.

## Web/runtime configuration

The web Container App receives:

| Kind | Settings |
|---|---|
| Nonsecret | `NODE_ENV=production`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_DEPLOYMENT_NAME`, `AZURE_CLIENT_ID`, `APP_ORIGIN`, `POSTHOG_HOST`, `ALERT_EMAIL_TO`, `AZURE_COMMUNICATION_EMAIL_SENDER`, `ROLLOUT_MODE` |
| Key Vault-backed | `DATABASE_URL`, `CRON_SECRET`, `POSTHOG_API_KEY`, `AZURE_COMMUNICATION_CONNECTION_STRING`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` |

`DIRECT_URL` never reaches the runtime.

## Scheduler and ops jobs

The hourly job runs at `0 * * * *` UTC and the daily-summary job at
`5 0 * * *` UTC. Both execute:

```text
node --experimental-strip-types scripts/scheduled-trigger.mjs
```

from the same digest-pinned web image. The script sends
`x-cron-secret`, `x-required-rollout-mode`, and, for agent runs, an
idempotency key. An attended Manual shadow proof uses a unique
`manual-shadow:` key. Scheduled hourly keys combine the exact image digest,
the activation generation, and the UTC hour, so an older image/generation in
the same hour cannot satisfy current observation. Run acquisition rejects an
idempotency key already persisted under a different rollout mode. Release
deploys both jobs as `Manual`; only `rollout.bicep` may set `Schedule`.

`release.bicep` creates five separate manual ops jobs:

| Job | Extra nonsecret settings | Mounted secrets |
|---|---|---|
| `migrate-init` | `AZURE_RUNTIME_LOGIN_ROLE` | `DIRECT_URL`, `DATABASE_URL`, `AZURE_RUNTIME_LOGIN_PASSWORD` |
| `preflight` | — | `DATABASE_URL`, `DIRECT_URL` |
| `verified-backup` | — | `DATABASE_URL`, `DIRECT_URL` |
| `target-smoke` | target URL/host, digest, disabled mode, Azure OpenAI base/deployment, `POSTHOG_HOST` | `CRON_SECRET`, `ADMIN_PASSWORD`, `DIRECT_URL`, `POSTHOG_API_KEY`, `DEPLOYMENT_APPROVAL_SECRET` |
| `activation-check` | target origin, digest | `CRON_SECRET`, `DIRECT_URL`, `DEPLOYMENT_APPROVAL_SECRET` |

All five also receive `ENVIRONMENT_NAME`, `RELEASE_SHA`,
`EVIDENCE_CONTAINER_URL`, `AZCOPY_MSI_CLIENT_ID`, and `AZURE_CLIENT_ID`.
`AZURE_CLIENT_ID` selects the ops identity for Foundry; no model credential is
mounted.

## Safe per-execution full-template override

`JOB_EXECUTION_ID` has no static Bicep value.
`.github/scripts/azure/run-ops-job.sh`:

1. reads the complete live job definition;
2. extracts `properties.template`;
3. rejects any template `volumes` and any container/init-container
   `volumeMounts`;
4. requires exactly one container;
5. always replaces/adds the validated `JOB_EXECUTION_ID`;
6. for attended dev proof only, may additionally replace/add the allowlisted
   validated `SCHEDULED_IDEMPOTENCY_KEY`,
   `EXPECTED_SHADOW_IDEMPOTENCY_KEY`, and
   `EXPECTED_SHADOW_STARTED_AFTER`;
7. leaves every other non-allowlisted environment entry, image, command,
   secret reference, retry, and timeout unchanged; and
8. starts with `az containerapp job start --yaml`.

The scheduled and expected shadow keys must use the unique
`manual-shadow:<safe-value>` form. The expected start boundary must be a
second-precision UTC timestamp. Unknown arguments or invalid values fail
before Azure execution.

Azure replaces the execution template when any start override is supplied.
Azure `JobExecutionTemplate` cannot preserve volume definitions through this
override path, so the helper fails closed instead of silently dropping them.
Current Project Krypto jobs use no volumes or volume mounts. Using an env-only
job-start override is prohibited: it can discard the rest of the live template.

## Monitoring

`environment.bicep` creates:

- a Log Analytics workspace;
- an email Action Group; and
- a severity-1 scheduled-query alert that checks both scheduler jobs for
  terminal failure signals every five minutes over a 15-minute window.

`schedule-monitoring.bicep` independently owns the absence alert so neither an
environment redeploy nor a rollout-state deployment can reset monitoring.
`infra/params/schedule-monitoring.dev.bicepparam` and
`infra/params/schedule-monitoring.prod.bicepparam` default it to disabled at
boundary `0`:

- alert name `alert-caj-<env>-agent-run-missing-success`;
- disabled while hourly trigger type is `Manual`;
- enabled before a `Schedule` rollout;
- bound to the workflow-supplied UTC schedule activation timestamp;
- live Log Analytics schema validation is fail-closed when enabling;
- two-hour lookback/grace measured within the current activation window; and
- severity 1 when no successful hourly completion exists after that grace.

The split is an ordering control. Before enabling `Schedule`, a workflow
what-ifs, deploys, and validates `schedule-monitoring.bicep` with the current
activation timestamp, then applies `rollout.bicep`. On disable, rollback, or
rotation, it reverses the safe dependency: apply `rollout.bicep`, verify both
jobs are `Manual` with no schedule, then deploy and verify disabled monitoring
with boundary `0`.

## Release and rollout safety

- `release.bicep` hardcodes web `ROLLOUT_MODE=disabled` and both scheduler jobs
  `Manual`.
- Committed rollout params default to disabled/manual. Committed
  schedule-monitoring params default to disabled with boundary `0`.
- Dev full deployment stages `shadow` with jobs Manual, starts exactly one
  attended hourly execution with a unique `manual-shadow:` key, then runs
  activation-check with that key and the pre-run timestamp. The report must
  prove the exact new SHADOW `AgentRun` started after the boundary, reached a
  safe terminal outcome, created zero `TradeExecution`, and released the
  lease. Activation also requires operator pause and drawdown lock to be
  explicitly false; missing or invalid control state blocks activation.
  This read-only check never clears either stop control.
- Schedule activation binds hourly idempotency to the exact image digest and
  current activation generation before observing scheduled success. Run
  acquisition rejects cross-mode replay of an existing key.
- Only after attended proof does dev enable and validate monitoring, enable
  Schedule, and observe a real scheduled success.
- Failure from dev shadow staging onward triggers automatic rollback to
  disabled/manual, verifies both jobs are Manual, and only then disables
  monitoring.
- Prod acquires an ops-owned, signed-source-bound database fence **before**
  forced disable or any infrastructure mutation. An open paper position or
  valid active lease defers without changing the healthy release. Stops,
  unreconciled accounting, malformed/expired leases, stale ownership, or an
  expired fence block the cutover. Source release lineage, digest, origin,
  candidate SHA, owner, and actual Azure execution identity are checked.
- Admission has no automatic replica retries. Deferral requires a terminal
  failed Azure execution and its exact immutable deferred report; timeouts,
  unknown submissions, or another execution's report are failures, not deferral.
- The immutable repository ID and workflow run ID derive a stable UUID v5
  cutover owner, unchanged on failed-job retries. Execution/evidence IDs still
  include the attempt. Completed owners retain their own database rows; a
  partial unique index permits only one unreleased fence. An active foreign
  owner takes precedence over any older completed record.
- After admission, prod proves disabled/Manual and quiescence, then takes a
  verified backup **before** `environment.bicep` mutates infrastructure.
  Existing-release updates preserve the PostgreSQL administrator password.
  The current-release backup uses a
  `JOB_EXECUTION_ID` ending `-current`, preventing a same-SHA collision with
  new-release baseline evidence. Its forced-disable path verifies Manual jobs
  before disabling monitoring.
- The runtime and paper executor can read but cannot mutate the fence.
  Every mutation stage, including forced disable and its monitoring change,
  revalidates the actual owner and six-hour deadline.
  Expiry never resumes execution or permits ownership theft; seed/reset do
  not clear active or completed owners. A pre-release failure leaves the fence
  held for owned recovery.
- After migrations and a restore-verified baseline backup, prod verifies the
  new disabled release and all inactive revisions are quiescent before the
  exact owner releases the fence and target-smoke runs. Release preserves
  operator/drawdown stops and every completed owner's replay protection.
- Migration/backup, release, and target-smoke are separate jobs. After an
  ambiguous release response, retrying the failed release job rechecks live
  quiescence and uses exact-owner idempotent release, not held-fence verification.
  A smoke failure before approval persistence retries only smoke and its live
  quiescence barrier. It does not repeat migrations or reacquire a released
  owner. Use failed-job recovery, not a new dispatch or an all-jobs rerun that
  attempts to replay the old source binding.
- After release, disabled/Manual remains the runtime guard while smoke is
  pending or failed. This ordering lets the disabled cron smoke execute after
  the fence is released without enabling trading or schedules. Neither fence
  release nor a passing disabled smoke is evidence of production promotion.
- Prod full deployment and secret rotation end disabled/manual. No executable
  production promotion workflow is shipped or approved.
- Prod deploy and rotation share concurrency group
  `azure-production-mutation`.

Fence ownership is a database safety control, not a substitute for Azure
readback. Quiescence requires the desired ready revision, exact images,
zero replicas on every inactive revision, disabled/Manual jobs without event
or schedule configuration, and only known-terminal scheduler executions.
Missing state is never interpreted as zero replicas or successful shutdown.

Existing-source ops images and databases must already support cutover admission.
A pre-fence source cannot be adopted by skipping its handshake. The selected
new target uses the explicit fresh disabled-release path; adopting a legacy
source requires a separately reviewed compatibility/migration procedure.

## Evidence storage

The ops identity has container-scoped Storage Blob Data Contributor. The
appropriate GitHub OIDC identities have container-scoped Storage Blob Data
Reader. Shared-key access and public blob access are disabled.

Evidence uses:

```text
<environment>/<release-sha>/<operation>/<job-execution-id>/report.json
```

The dev retention parameter is 7 days; prod is 90 days. An unlocked
time-based immutability policy already prevents blob overwrite/delete during
retention. Azure does not expose the irreversible lock action as a Bicep
property, so production still requires one deliberate post-foundation
operator action to lock the policy. Never automate or repeat that action
casually.

## Outputs

Important outputs are intentionally passed through protected workflow
artifacts rather than copied into public docs:

- bootstrap: resource-group names and OIDC client/principal/resource IDs;
- environment: ACR/Container Apps IDs, all workload identity IDs, evidence
  URL/retention, ACS service/sender, Log Analytics and Action Group IDs;
- release: public app FQDN and seven job names; and
- rollout: FQDN, mode, and trigger types;
- schedule monitoring: absence-alert state and activation timestamp.

Do not infer outputs or substitute placeholders in a live deployment.

## Compile-time validation

These commands validate syntax/type contracts only; they do not prove Azure
availability or create live evidence:

```bash
az bicep build --file infra/bootstrap.bicep
az bicep build --file infra/platform-account.bicep
az bicep build --file infra/platform.bicep
az bicep build --file infra/platform-access.bicep
az bicep build --file infra/environment.bicep
az bicep build --file infra/release.bicep
az bicep build --file infra/rollout.bicep
az bicep build --file infra/schedule-monitoring.bicep
for f in infra/modules/*.bicep; do az bicep build --file "$f"; done
```

For `.bicepparam` compilation, export inert local stubs only:

```bash
POSTGRES_ADMIN_PASSWORD_DEV=stub POSTGRES_ADMIN_PASSWORD_PROD=stub \
DATABASE_URL_DEV=stub DIRECT_URL_DEV=stub CRON_SECRET_DEV=stub \
POSTHOG_API_KEY_DEV=stub ADMIN_PASSWORD_DEV=stub \
ADMIN_SESSION_SECRET_DEV=stub RUNTIME_DATABASE_PASSWORD_DEV=stub \
DEPLOYMENT_APPROVAL_SECRET_DEV=stub \
DATABASE_URL_PROD=stub DIRECT_URL_PROD=stub CRON_SECRET_PROD=stub \
POSTHOG_API_KEY_PROD=stub ADMIN_PASSWORD_PROD=stub \
ADMIN_SESSION_SECRET_PROD=stub RUNTIME_DATABASE_PASSWORD_PROD=stub \
DEPLOYMENT_APPROVAL_SECRET_PROD=stub \
  bash -c 'for f in infra/params/*.bicepparam; do az bicep build-params --file "$f"; done'
```

Never use real secret values for compile-only validation.

## Principal API versions

- Cognitive Services account/deployments: `2025-06-01`
- Communication Services/Email/domains: `2025-09-01`
- Container Apps/app/jobs: `2025-01-01`
- PostgreSQL Flexible Server: `2024-08-01`
- Key Vault/secrets: `2024-11-01`
- Log Analytics: `2025-02-01`
- scheduled-query rules: `2023-12-01`
- action groups: `2023-01-01`
- managed identities/federated credentials: `2024-11-30`
- role assignments: `2022-04-01`
- resource locks: `2020-05-01`

## Known limitations

- The Foundry data-plane endpoint is public at the network layer, but local
  auth is disabled and callers still require the reviewed Entra role.
- Container Apps ingress is external; PostgreSQL alone is private-only.
- Key Vault and evidence storage use public network paths with Azure RBAC,
  not private endpoints.
- One ops UAMI is shared by five jobs. Its Key Vault permissions are the
  union shown above, while each job's mounted env remains narrower.
- `rollout.bicep` re-declares app/scheduler resources. Workflows must resolve
  and pass the exact currently deployed image, model, ACS sender, PostHog
  host, and recipient to avoid unintended drift.
- A partial deterministic prod release is neither a valid current release nor
  a fresh environment; the prod workflow fails closed.
- Live results are limited to the bootstrap/platform/foundation/access
  checkpoint documented above. No release, application URL, ops-job report,
  target smoke, or schedule result is implied.
