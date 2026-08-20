# Deployment runbook (Azure)

> **Live state (2026-08-19): both Azure releases remain deployed.** Dev is
> `shadow` with monitored hourly/daily schedules. Production is `disabled`
> with all jobs `Manual`. The exact-SHA dev evidence retry for
> `00481ac26ea2da3dce8600207add5a7376abca38` is blocked on operational
> Foundry workload access; do not call that access complete until protected
> read-only verification proves local authentication is disabled, four exact
> workload bindings, no extra effective access, and zero scheduler access. No production
> promotion is shipped or authorized.
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
| Operational Foundry resource group | `ghcp-foundry-models` |
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

### Current live checkpoint

| Stage | Live state | Evidence |
|---|---|---|
| Providers/bootstrap | Required providers are registered; platform/dev/prod resource groups and four GitHub OIDC identities exist | Complete |
| GitHub controls | Environments, branch restrictions, variables, and release secrets are configured. `production-deploy`, `production-promotion`, `platform`, and `development-promotion` carry human required-reviewer protection (verified via the GitHub API); `development` carries only a branch policy and is the sole environment the factory mutates automatically, behind branch, exact-SHA, and CI gates. | Live; reviewer enforcement active on human-gated environments |
| Foundry platform | Dedicated account remains model-empty after `715-123420`; fallback dev/prod Luna deployments on `ghcp-foundry-eastus2` succeeded and passed Entra plain/structured smokes. | Operational fallback complete |
| Workload access | Read-only inspection found no inherited Cognitive Services OpenAI User assignment for the dev runtime or ops identity on the operational account; all four workload bindings plus both scheduler-zero checks require exact verification | **Not complete; human-only operational apply required** |
| Dev release | Prior release remains live in shadow; automatic run `32311854032` for exact SHA `00481ac26ea2da3dce8600207add5a7376abca38` reached target smoke and failed provider connectivity with `PermissionDenied` | Retry exact-SHA evidence after access verification |
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
| `platform` | `azure-platform.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PLATFORM_RESOURCE_GROUP_NAME`, `FOUNDRY_RESOURCE_NAME`, `PLATFORM_IDENTITY_PRINCIPAL_ID` | none | `develop/azure`, `main` |
| `platform` | `azure-platform-access.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`; operation and Foundry account/resource group are exact reviewed dispatch choices | none | `develop/azure`, `main` |
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

The platform identity's bootstrap roles in `rg-krypto-platform` do not extend
to the operational account in `ghcp-foundry-models`. Before the access
workflow targets that account, an authorized human must arrange the minimum
reviewed permissions for the identity that actually applies the template:
resource-group deployment permission at the selected group and
`Microsoft.Authorization/roleAssignments/write` at the selected account scope,
plus the corresponding read permissions required by exact verification. A
human approval of the GitHub `platform` environment does not lend the
reviewer's Azure permissions to the workflow OIDC identity. Do not widen
bootstrap or subscription RBAC automatically.

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

**Current status: operational fallback models live; workload access
remediation pending.** The
[platform run](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/31839812884)
created and verified `ai-krypto-westus3`, disabled local auth, verified the
`CanNotDelete` lock, and passed exact catalog/quota validation. Azure rejected
model deployment with error `715-123420` (“unusual activity”). The exact dev
and prod Luna deployments were then created serially on the established
`ghcp-foundry-eastus2` account and passed platform Entra plain plus strict
structured `HOLD` smokes. Those platform smokes do not prove workload-identity
authorization. Automatic dev deploy run `32311854032` later failed target
smoke provider connectivity with `PermissionDenied`, and read-only inspection
found zero inherited **Cognitive Services OpenAI User** assignments for the dev
runtime and ops identities. Keep the dedicated account for a future migration.

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
GitHub Deployment (`environment: "development"`, `transient_environment:
true`, `production_environment: false`) on that SHA, and structurally
verifies rollback: any promotion-stage failure after a successful deploy
triggers a fail-closed rollback path whose outcome is recorded in the same
evidence. This mechanism has not yet been exercised by an actual production
incident; treat "structurally verifies rollback on failure" and "a rollback
has been observed in production" as two different claims. Production has no
automatic trigger and must be dispatched manually with an explicit
`commit_sha` at each stage, behind its required-reviewer environments.

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

Both foundations are mandatory because Bicep resolves the four fixed
runtime/ops UAMIs and binds them in one account-scoped access deployment; the
protected verifier separately resolves both schedulers for zero-access proof.

## 5. Bind Foundry workload access

**Current status: not complete.** The operational account is the active model
host, but exact assignment verification has not passed. The known dev
runtime/ops assignments are absent; the prod pair must also be verified rather
than inferred from older prose or platform-level smokes.

Select exactly one reviewed account/resource-group pair:

| Target | Foundry account | Resource group |
|---|---|---|
| Operational (current) | `ghcp-foundry-eastus2` | `ghcp-foundry-models` |
| Dedicated (future migration) | `ai-krypto-westus3` | `rg-krypto-platform` |

The workflow allows only those exact account/resource-group pairs. Bicep
allowlists the account name and resolves that existing account in the actual
deployment resource group, so a direct cross-combined invocation cannot resolve
the reviewed account and fails before role assignment.

Principal IDs are not inputs. Bicep resolves the four runtime/ops identities,
and the protected workflow independently resolves those four plus:

- `id-krypto-dev-scheduler` in `rg-krypto-dev`; and
- `id-krypto-prod-scheduler` in `rg-krypto-prod`.

Workflow verification must match all six exact UAMI resource IDs and produce
six distinct service-principal object IDs. Only runtime and ops receive
**Cognitive Services OpenAI User**. Direct Bicep apply does not prove scheduler
state; the protected verification step must prove both schedulers have zero
Foundry access.

`azure-platform-access.yml` has two operations:

- `verify` is read-only and may target either reviewed account pair;
- `apply-dedicated` runs what-if, rejects deletes, publishes the artifact, and
  applies only `ai-krypto-westus3` / `rg-krypto-platform` behind the protected
  `platform` environment.

The workflow rejects an operational apply before Azure login. Do not grant
`id-github-oidc-platform` `Microsoft.Authorization/roleAssignments/write` on
`ghcp-foundry-eastus2`, `ghcp-foundry-models`, or any ancestor. Operational
mutation is an explicit human-only fallback.

The read-only workflow identity requires only:

- `Microsoft.CognitiveServices/accounts/read` and
  `Microsoft.Authorization/roleAssignments/read` at the selected account; and
- `Microsoft.ManagedIdentity/userAssignedIdentities/read` on the six exact
  UAMIs listed above.

These are human-managed prerequisites. Do not add them to bootstrap or widen
them to subscription scope. Azure verification enumerates direct/inherited
assignments at the account and direct assignments below it. Because Azure CLI's
`--include-groups` is user-specific and does not prove managed-identity group
inheritance, a separate human Microsoft Graph check must prove all six UAMIs
have zero transitive group memberships.
It first fails closed unless the selected account reports
`properties.disableLocalAuth == true`; role assignments are not a complete
keyless boundary while local key authentication remains enabled.
Each workload UAMI must have exactly one result: a direct account-scoped
**Cognitive Services OpenAI User** assignment with principal type
`ServicePrincipal`. Any inherited, child-scope, custom, or broader extra result
fails closed. Both scheduler UAMIs must return zero.

Do not proceed to a full release until the live assignment verification
passes. This is the dependency bridge between the application foundations and
keyless model access.

### Operational remediation and dev-evidence retry order

1. An authorized human signs in interactively with Azure CLI. Confirm
   `az account show --query user.type --output tsv` returns `user`; do not use
   the platform OIDC identity. The human must already have resource-group
   deployment permission, identity/account/assignment read, and
   `Microsoft.Authorization/roleAssignments/write` at only the exact
   operational account scope.
2. From a reviewed commit, run `az deployment group what-if` for
   `infra/platform-access/main.bicep` in `ghcp-foundry-models` with
   `infra/params/platform-access.bicepparam`. Retain the full result and refuse
   any delete or any resource other than the four deterministic
   account-scoped assignments.

   ```bash
   az deployment group what-if \
     --resource-group ghcp-foundry-models \
     --template-file infra/platform-access/main.bicep \
     --parameters infra/params/platform-access.bicepparam \
     --result-format FullResourcePayloads \
     --no-pretty-print \
     --output json
   ```

3. The same human runs `az deployment group create` with the same resource
   group, template, and parameter file. The account and fixed UAMI references
   must resolve in their reviewed scopes. Do not paste principal IDs into documentation,
   issues, chat, or command parameters.

   ```bash
   az deployment group create \
     --resource-group ghcp-foundry-models \
     --name platform-access-operational-human \
     --template-file infra/platform-access/main.bicep \
     --parameters infra/params/platform-access.bicepparam \
     --output none
   ```

4. From the same interactive human Azure CLI session, verify all six fixed
   UAMIs have zero transitive Entra group memberships. This requires the
   directory read permission needed by Microsoft Graph; do not grant that
   permission to the platform OIDC identity.

   ```bash
   scripts/azure/verify-foundry-uami-groups.sh \
     --subscription "Visual Studio Enterprise Subscription"
   ```

5. Dispatch **Azure platform workload access** with `operation=verify` and the
   operational account/resource-group pair. Approve the protected `platform`
   environment. Require **Verify exact direct and inherited Foundry access** to
   prove local authentication is disabled, four exact workload assignments, no
   extras, and zero scheduler assignments. Only the human Graph proof plus this
   completed read-only verification makes workload access complete.

   ```bash
   gh workflow run azure-platform-access.yml \
     --ref main \
     -f operation=verify \
     -f foundry_account_name=ghcp-foundry-eastus2 \
     -f foundry_resource_group_name=ghcp-foundry-models \
     -f reviewed_source_sha=<exact-reviewed-main-sha>
   ```

6. Retry dev evidence for exact SHA
   `00481ac26ea2da3dce8600207add5a7376abca38`. Prefer **Re-run failed jobs** on
   automatic run `32311854032`, which preserves the original CI-bound SHA. If
   that rerun is unavailable, manually dispatch **Azure deploy dev** with that
   exact `commit_sha` and `deployment_stage=full`; its gate must find the
   existing successful push-triggered CI run.
7. Require the `Dev deployment evidence` status on that exact SHA to succeed.
   Do not substitute a moving branch ref or a newer SHA for this retry.

## 6. Dev full release and schedule activation

**Current status: complete; automatic trigger armed.** The dev release is
live in `shadow` with a monitored `Schedule`. The original manual `full` run
at the exact CI-passed SHA (below) established that state; the environment
now also runs automatically on every successful push-triggered `CI` run on
`main` (see §2 and §3), because `development` carries only a branch policy
and no required reviewer.

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
