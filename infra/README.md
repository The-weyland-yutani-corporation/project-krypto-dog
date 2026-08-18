# Project Krypto Azure infrastructure (Bicep)

This tree implements the Azure-native target accepted by
[`specs/decisions/0008-azure-native-deployment-architecture.md`](../specs/decisions/0008-azure-native-deployment-architecture.md).

> **Deployment state (2026-08-15): RELEASES + FOUNDRY AGENTS DEPLOYED.** Dev is
> shadow/scheduled; production is disabled/manual. Isolated dev/prod prompt
> agents version `1` are active and passed exact structured `HOLD` smokes. The
> next reviewed app release performs the runtime cutover.
>
> **Paper only.** Templates support `disabled`, `shadow`, and `paper`.
> Nothing provisions or authorizes live-money execution.

## Fixed target contract

- Runtime-selected subscription: **Visual Studio Enterprise Subscription**.
  Its ID and internal identifiers must not be published.
- Region: `westus3`.
- Resource groups: `rg-krypto-platform`, `rg-krypto-dev`,
  `rg-krypto-prod`.
- Dedicated future Foundry account: `ai-krypto-westus3`.
- Operational model host: established `ghcp-foundry-eastus2`.
- Model: OpenAI `gpt-5.6-luna`, version `2026-07-09`,
  `GlobalStandard`.
- Deployments: `krypto-dev-luna` and `krypto-prod-luna`, capacity 10 each.
- Runtime/ops callers use Microsoft Entra ID and project-scoped **Foundry Agent
  Consumer**. Project Krypto does not mount model or agent API keys.
- Email is per-environment Azure Communication Services Email with an
  Azure-managed domain.
- Every event is tagged with `deployment_environment`; separate PostHog
  projects remain required before production promotion.

`eastus2` was a rejected candidate because the selected subscription cannot
provision PostgreSQL there. It is not a current target.

## Live provisioning checkpoint

| Surface | Live state | Evidence |
|---|---|---|
| Subscription/bootstrap | Required providers registered; three resource groups and four GitHub OIDC identities exist | Bootstrap complete |
| GitHub controls | Enterprise-hosted Actions are active; `CI_RUNNER_LABEL` is unset, and the temporary Azure runner registrations/resource group are retired. Platform and both production environments require `@VeVarunSharma` review with `prevent_self_review=false`; development intentionally has no reviewer. Branch, exact-SHA, and CI gates remain mandatory. | Hosted execution and approvals active |
| Foundry accounts | Dedicated `ai-krypto-westus3` remains model-empty after `715-123420`; operational dev/prod Luna deployments on `ghcp-foundry-eastus2` succeeded and passed Entra smokes | Fallback active |
| Foundry agents | Separate dev/prod projects and toolless prompt agents version `1` are active; exact-definition and structured `HOLD` smokes passed | Applied |
| Foundry workload access | Dev runtime/ops have the proven custom-only `Project Krypto Foundry Agent Invoker`; the reviewed template adds the same project-scoped assignment for prod without changing live prod; legacy direct-model roles await app-image cutover | Dev proven; prod source ready |
| Dev foundation | ACR, private PostgreSQL 17, Key Vault, evidence storage, Container Apps environment, ACS Email managed domain, Log Analytics/alerts, and workload identities exist | [Foundation passed](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/31841581875) |
| Prod foundation | Same foundation resource classes exist with production controls | [Foundation passed](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/31841960745) |
| Releases | Dev/prod web Container Apps and scheduler/ops jobs are deployed; dev completed target-smoke and scheduled-run evidence, prod remains disabled/manual, and both still run the pre-agent image until the reviewed cutover release | Deployed with safety state |
| Analytics | Shared ingestion key temporarily staged with mandatory dev/prod event tags; separate projects remain a promotion gate | Release-testable |

Azure Support API ticket creation for the dedicated account failed because the
subscription has no eligible support plan. The established account removes
that release blocker; keep the dedicated account for a future migration.

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
  bootstrap.bicep          subscription scope: three RGs, four OIDC identities, custom role definitions, minimal read-only assignments
  platform-account.bicep   rg-krypto-platform: dedicated Foundry account + delete lock
  platform.bicep           rg-krypto-platform: pinned dev/prod Luna deployments
  foundry-agents.bicep     operational account RG: isolated projects and project-scoped agent RBAC
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
| `bootstrap.bicep` | Platform/dev/prod resource groups; four OIDC identities and RG roles; provider-state reader and Foundry Agent Invoker role definitions; minimal provider/quota read assignments | Other subscription permissions, application resources, model deployments, secrets |
| `platform-account.bicep` | Dedicated Foundry account and `CanNotDelete` lock | Model deployments or workload access |
| `platform.bicep` | Exact dev/prod model deployments and platform smoke role | Account lifecycle or application identities |
| `foundry-agents.bicep` | Dev/prod Foundry projects; project identities/deployer Foundry User; one matching custom Agent Invoker assignment per runtime/ops identity | Models, application resources, or trading permissions |
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
| `id-github-oidc-platform` | `platform` | `rg-krypto-platform`: Contributor, Role Based Access Control Administrator, Locks Contributor | **Project Krypto Provider Registration Reader**; **Cognitive Services Usages Reader** | `platform-account.bicep`, `platform.bicep` |
| `id-github-oidc-dev` | `development` | `rg-krypto-dev`: Contributor, Role Based Access Control Administrator | **Project Krypto Provider Registration Reader** | `environment.bicep`, `release.bicep`, `rollout.bicep`, `schedule-monitoring.bicep` |
| `id-github-oidc-prod-deploy` | `production-deploy` | `rg-krypto-prod`: Contributor, Role Based Access Control Administrator, Locks Contributor | **Project Krypto Provider Registration Reader** | `environment.bicep`, `release.bicep` |
| `id-github-oidc-prod-promotion` | `production-promotion` | `rg-krypto-prod`: Contributor | none | Forced-disable jobs in prod deploy/rotation only: `rollout.bicep`, then `schedule-monitoring.bicep` |

The custom **Project Krypto Provider Registration Reader** contains exactly
`Microsoft.Resources/subscriptions/providers/read`. It is assigned at
subscription scope only to the platform, dev, and prod-deploy identities so
their workflow `--check-only` steps can inspect provider state without broad
Reader. It cannot register providers; the prod-promotion identity does not
receive it.

Bootstrap also defines **Project Krypto Foundry Agent Invoker** with deterministic
role ID `44dfdabf-22ec-45f5-923b-b42e44bdad76`. It has no control-plane actions,
delete/state/key permissions, or subscription-level assignment. Its only data
actions are agent read/write, Responses read/write, and endpoint interaction;
`foundry-agents.bicep` assigns it only at an environment project scope.

Azure enforces resource-group scope, not the intended template list. A
resource-group Contributor can deploy other resources in that group.
Template separation therefore also depends on protected workflow files,
GitHub Environment reviewers, branch rules, and CODEOWNERS. The `platform`,
`production-deploy`, and `production-promotion` environments require review by
`@VeVarunSharma` with `prevent_self_review=false`. `development` intentionally
has no required reviewer for routine dev delivery. Every path still requires
its configured branch, exact source SHA, and successful CI.

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
role-assignment allow-list. Platform and production environment approvals are
therefore mandatory mutation controls in addition to source review and
exact-SHA/CI gates.

All mutation permissions remain resource-group-scoped. Subscription scope is
read-only: the minimal provider-state role above, plus **Cognitive Services
Usages Reader** on the platform identity for live regional quota inspection.
Neither grants provider registration or any other subscription mutation.

No long-lived Azure service-principal credential is stored in GitHub.

## Dedicated Foundry platform

### Account lifecycle

`platform-account.bicep` creates `ai-krypto-westus3` as
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
`bootstrap.bicep` defines the custom **Project Krypto Foundry Agent Invoker**.
`foundry-agents.bicep` assigns that one role at the matching project scope to:

- dev runtime;
- dev ops;
- prod runtime; and
- prod ops.

The role has exactly these data actions:

- `Microsoft.CognitiveServices/accounts/AIServices/agents/read`;
- `Microsoft.CognitiveServices/accounts/AIServices/agents/write`;
- `Microsoft.CognitiveServices/accounts/AIServices/responses/read`;
- `Microsoft.CognitiveServices/accounts/AIServices/responses/write`; and
- `Microsoft.CognitiveServices/accounts/AIServices/endpoints/interact/action`.

The `agents/write` data action is required by Foundry's version-pinned prompt
invocation path to create internal agent messages. The role has empty
`Actions`, `NotActions`, and `NotDataActions`, and no delete, state, key, or
infrastructure permission. The three partial built-ins are not layered with it.
The broad **Foundry User** role remains limited to the attended deployer and
project managed identities. Schedulers invoke the application and receive no
direct Foundry access.

Incremental ARM deployments do not delete superseded role assignments. Before
accepting rollout evidence, verify each runtime/ops identity has only the custom
invoker on its matching project and remove any prior Agent Consumer, Project
Runtime User, or Data Reader proof assignments. Dev is already custom-only;
live production remains unchanged until an approved apply.
Runtime configuration is:

```text
AZURE_FOUNDRY_PROJECT_ENDPOINT=<environment project endpoint>
AZURE_FOUNDRY_AGENT_NAME=krypto-dev-decision | krypto-prod-decision
AZURE_FOUNDRY_AGENT_VERSION=<exact attested immutable version>
AZURE_CLIENT_ID=<matching runtime-or-ops UAMI client ID>
```

There is no model/agent API key or dated runtime API-version setting. Optional
direct-model diagnostics are restricted to an attended platform operator.

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
| dev | `acs-krypto-dev` | `email-krypto-dev` |
| prod | `acs-krypto-prod` | `email-krypto-prod` |

The Azure-managed sender is an `environment.bicep` output. No custom DNS is
required.

## Deployment order and foundation handoff

1. Subscription owner runs `register-providers.sh` and waits for `Registered`.
2. Local `bootstrap.bicep`.
3. Provision the exact Luna deployment pair and run Entra no-trade smokes.
   Current operation uses established `ghcp-foundry-eastus2`; the dedicated
   `azure-platform.yml` path remains available for a future migration.
4. `azure-deploy-dev.yml` with `deployment_stage=foundation`.
5. `azure-deploy-prod.yml` with `deployment_stage=foundation`.
6. Authenticated local `foundry-agents.bicep` apply plus exact dev/prod agent
   deploy/attestation/HOLD smokes (historical first deployment; Enterprise-hosted
   Actions are now available).
7. Full dev release and monitored shadow activation.
8. Full prod release, ending disabled/manual. No production promotion
   workflow is shipped or approved.

Current checkpoint: all steps are complete for the pre-agent application.
Dev is shadow/scheduled with monitored activation evidence, and prod is
deployed disabled/manual. Agent resources are complete and the dev custom
invoker is proven. Apply the reviewed prod custom assignment before its
cutover; repeat steps 7 and 8 with the agent-integrated image before deleting
legacy account-scoped model roles.

Both foundation workflows publish a nonsecret handoff artifact containing
identity IDs, evidence metadata, ACS sender, and monitoring IDs. The Foundry
Agent deployment consumes the retained principal IDs explicitly; it does not
guess them.

Manual workflows support `foundation` and `full`; the workflow definition maps
`workflow_run` events to `full`. Routine development can run without an
environment reviewer, but still requires the configured branch, exact CI-passed
SHA, and CI gate. Platform and production mutations additionally require their
live GitHub Environment approval.

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
| runtime | Web Container App | `database-url`, `cron-secret`, `posthog-api-key`, `azure-communication-connection-string`, `admin-password`, `admin-session-secret` | ACR pull; project-scoped Project Krypto Foundry Agent Invoker |
| scheduler | Hourly and daily jobs | `cron-secret` only | ACR pull; no Foundry role |
| ops | Five manual jobs | Union of `database-url`, `direct-url`, `cron-secret`, `admin-password`, `posthog-api-key`, `runtime-database-password`, `deployment-approval-secret` | ACR pull; evidence-container writer; project-scoped Project Krypto Foundry Agent Invoker |

The ops identity never receives the ACS connection string or admin session
secret. Target smoke validates ACS by asking the running app to send and
persist a daily-summary delivery; the runtime, not the ops process, holds the
ACS secret.

## Web/runtime configuration

The web Container App receives:

| Kind | Settings |
|---|---|
| Nonsecret | `NODE_ENV=production`, `AZURE_FOUNDRY_PROJECT_ENDPOINT`, `AZURE_FOUNDRY_AGENT_NAME`, immutable `AZURE_FOUNDRY_AGENT_VERSION`, `AZURE_CLIENT_ID`, `APP_ORIGIN`, `POSTHOG_HOST`, `ALERT_EMAIL_TO`, `AZURE_COMMUNICATION_EMAIL_SENDER`, `ROLLOUT_MODE` |
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
  lease.
- Schedule activation binds hourly idempotency to the exact image digest and
  current activation generation before observing scheduled success. Run
  acquisition rejects cross-mode replay of an existing key.
- Only after attended proof does dev enable and validate monitoring, enable
  Schedule, and observe a real scheduled success.
- Failure from dev shadow staging onward triggers automatic rollback to
  disabled/manual, verifies both jobs are Manual, and only then disables
  monitoring.
- Prod detects and force-disables a complete current release and takes a
  verified backup **before** `environment.bicep` can rotate credentials or
  mutate infrastructure. That current-release backup uses a
  `JOB_EXECUTION_ID` ending `-current`, preventing a same-SHA collision with
  new-release baseline evidence. Its forced-disable path verifies Manual jobs
  before disabling monitoring.
- Prod full deployment and secret rotation end disabled/manual. No executable
  production promotion workflow is shipped or approved.
- Prod deploy and rotation share concurrency group
  `azure-production-mutation`.

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
az bicep build --file infra/foundry-agents.bicep
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

- The operational fallback account is shared and still has legacy local/model
  key authentication enabled. Project Krypto stores no key and Agent calls use
  Entra with the project-scoped custom invoker, but account-wide local auth
  remains a production-promotion blocker. Disable it with the account owner or
  migrate to the Entra-only dedicated account before any promotion design.
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
- Live pre-agent releases and evidence exist: dev is shadow/scheduled and prod
  disabled/manual. The agent-integrated image release and subsequent operational
  account role retirement are not yet implied.
