# Project Krypto — Azure infrastructure (Bicep)

This tree implements the Azure-native deployment architecture accepted in
[`specs/decisions/0008-azure-native-deployment-architecture.md`](../specs/decisions/0008-azure-native-deployment-architecture.md).
It is infrastructure only: no application code, npm scripts, database
migrations, or GitHub Actions workflows are added or changed by this tree.

**v2 is paper trading only.** Nothing here provisions or authorizes any
live-money execution path. Production is deployed and defaults to
`ROLLOUT_MODE=disabled` with both scheduler jobs on the `Manual` trigger;
promoting either requires a separate, explicitly reviewed deploy of
`rollout.bicep` (see below).

## Layout

```
infra/
  bootstrap.bicep      subscription scope — one-time: resource groups, GitHub OIDC identities
  platform.bicep       resource group scope — existing Foundry account, dev/prod model deployments
  environment.bicep    resource group scope — per-environment platform (network, ACR,
                        Container Apps environment, PostgreSQL, Key Vault, storage, monitoring,
                        runtime/scheduler/ops identities)
  release.bicep        resource group scope — web Container App + scheduler jobs + five manual
                        operations jobs + Key Vault secrets
  rollout.bicep         resource group scope — ONLY template that flips ROLLOUT_MODE and
                        scheduler job trigger types (Manual <-> Schedule)
  modules/              reusable building blocks used by the templates above
  params/                 nonsecret .bicepparam files, one pair (dev/prod) per per-environment template
```

## GitHub Environments and OIDC identities

`bootstrap.bicep` creates **four** GitHub OIDC-federated user-assigned
identities, matching four approved GitHub Environments, each scoped to
only the one resource group (or, for `platform`, the one pre-existing
resource group) it is allowed to deploy into:

| Identity | GitHub Environment | Scope | Deploys | RBAC-granting role? |
|---|---|---|---|---|
| dev | `development` | dev resource group | `environment.bicep`, `release.bicep`, `rollout.bicep` for dev | Yes (`Contributor` + `Role Based Access Control Administrator`) |
| prod deploy | `production-deploy` | prod resource group | `environment.bicep`, `release.bicep` for prod (never `rollout.bicep`) | Yes |
| prod promotion | `production-promotion` | prod resource group | `rollout.bicep` for prod only | No (`Contributor` only — `rollout.bicep` never creates a role assignment) |
| platform | `platform` | the **existing** resource group that already holds the Foundry account | `platform.bicep` only | No |

Splitting prod deploy from prod promotion means the identity that can ship
a new prod image can never itself flip `ROLLOUT_MODE`/trigger types, and
the identity that can promote a rollout can never ship a new image or
touch a secret — each is a distinct, separately-reviewable GitHub
Environment approval gate. The platform identity is scoped to its own
resource group only: it is never given any right in the dev/prod resource
groups, and the dev/prod identities are never given any right in the
platform resource group, so a compromised or over-broadly-approved
workflow run in one environment cannot reach into another.

**What is and is not Azure-enforced here:** the resource-group scoping in
the table above (dev resource group vs. prod resource group vs. the
platform resource group) *is* an Azure RBAC-enforced boundary — none of
these identities has any Azure permission outside its own resource group,
full stop. But "prod deploy never runs `rollout.bicep`" and "prod
promotion never runs `release.bicep`" are **not** Azure-enforced action
restrictions — `Contributor` on a resource group can deploy any template
into it, including one this repo did not intend that identity to run.
That separation is a **process/workflow control**: which template a given
GitHub Environment's protected workflow is configured to invoke, together
with GitHub Environment protection rules (required reviewers, branch
restrictions) gating who can trigger that workflow. If a workflow file
were modified (or a new one added) to call `release.bicep` using the prod
promotion identity's federated credential, Azure RBAC alone would not
prevent that deploy from succeeding within the prod resource group.

`bootstrap.bicep`'s `platformResourceGroupName` parameter must be the name
of a resource group that **already exists** (it is not created by this
template) — supply the real name of whatever resource group holds your
existing Microsoft Foundry account. This value is never invented; the
committed `.bicepparam` file carries an explicit `REPLACE_WITH_...` token
for it.

We use **`Role Based Access Control Administrator`**
(`f58310d9-a9f6-439a-9e8d-f62e7b41a168`) rather than the older
**`User Access Administrator`** (`18d7d88d-d35e-4fbf-a041-3c1c4a710aa4`)
for the RBAC-granting identities, as the current, non-deprecated built-in
role for this purpose. **This is a protected-bootstrap-workflow tradeoff,
not an Azure-enforced privilege-escalation guard**: live role definition
inspection (`az role definition list --name "Role Based Access Control
Administrator"`) confirms this role grants
`Microsoft.Authorization/roleAssignments/write` and `/delete` with **no
`condition` and no `notActions`** restricting which roles it may assign —
it can assign `Owner`, `User Access Administrator`, or itself just as
readily as it can assign `AcrPull`/`Key Vault Secrets User`/`Storage Blob
Data Contributor`. The actual limiting factors are (a) this identity's
Azure RBAC scope is a single resource group, never subscription-wide, and
(b) which Bicep templates that identity's GitHub Environment is permitted
to run is a **process/workflow-approval control** (GitHub Environment
protection rules, required reviewers, branch restrictions) — not
something Azure itself enforces on the role assignment. A compromised or
over-broadly-approved workflow run holding this identity's federated
credential could still assign `Owner` (or anything else) within that one
resource group if workflow-level protections did not prevent it.

## Deployment order

1. **`bootstrap.bicep`** (subscription scope, one time). Creates the `dev`
   and `prod` resource groups and the four GitHub OIDC-federated
   identities above. Re-run only if the repo/org name or GitHub
   Environment names change.
2. **`platform.bicep`** (resource group scope, deployed into the resource
   group that already holds the **existing** Microsoft Foundry account —
   not a group this repo creates). Declares the dev and prod model
   deployments under that one shared account. Deployed once; re-run when
   model/version/SKU/capacity changes for either environment.
3. **`environment.bicep`** (resource group scope, once per environment —
   `dev` and `prod` each get their own deploy into their own resource
   group from step 1). Creates the per-environment platform: VNet, ACR,
   Container Apps environment, PostgreSQL Flexible Server 17, Key Vault,
   evidence storage, Log Analytics + Action Group, and the runtime/
   scheduler/ops managed identities with their non-secret-dependent RBAC.
   Also grants the GitHub OIDC deployment identities from step 1
   read-only (`Storage Blob Data Reader`, container-scoped) access to the
   evidence container via `evidenceReaderPrincipalIds` — CI/CD workflows
   need this to download versioned ops-job reports with
   `az storage blob download --auth-mode login`, since shared key access
   is disabled and RG-scoped Contributor grants no storage data-plane
   access on its own. This means step 1 must run first: copy
   `devIdentityPrincipalId` into `environment.dev.bicepparam`'s
   `evidenceReaderPrincipalIds`, and both `prodDeployIdentityPrincipalId`
   and `prodPromotionIdentityPrincipalId` into
   `environment.prod.bicepparam`'s, before deploying this template. This
   step also deploys the evidence container's (unlocked) time-based
   immutability policy — for production, plan a separate, manual,
   one-time `az storage container immutability-policy lock` step after
   this deploy (see "Design limitations" below); no template performs it.
4. **`release.bicep`** (resource group scope, once per environment).
   Creates the Key Vault secrets, the per-secret RBAC that binds each
   identity to only the secrets it needs, the web Container App (digest-
   pinned image, `ROLLOUT_MODE=disabled` always), the two scheduler
   Container Apps Jobs (hourly agent-run, daily summary — both `Manual`
   trigger), and the five manual operations Container Apps Jobs (see
   below). Re-run to ship a new image digest or rotate a secret value;
   every re-run re-lands the schedule state at disabled/manual.
5. **`rollout.bicep`** (resource group scope, once per environment, only
   after step 4 has already produced passing smoke/binding evidence for
   the target revision). The only template that may set `rolloutMode` to
   `shadow`/`paper` or a scheduler job's trigger type to `Schedule`. Every
   other input (image digest, Foundry config, alert emails) must match
   what `release.bicep` currently has deployed — this template does not
   ship new images or secrets, only rollout-state changes.

Each template's header comment repeats the exact `az deployment ... create`
invocation.

## Scheduler jobs run the real trigger script, not curl

The hourly (`0 * * * *` UTC) and daily (`5 0 * * *` UTC) Container Apps
Jobs run:

```
command: ['node']
args:    ['--experimental-strip-types', 'scripts/scheduled-trigger.mjs']
```

from the **same digest-pinned web image** as the web app itself (the
Dockerfile's `web` build target contains `scripts/scheduled-trigger.mjs`
specifically for this purpose — there is no separate "scheduler" image to
keep in sync). This script (see
[`src/deployment/scheduled-trigger.ts`](../src/deployment/scheduled-trigger.ts))
sends the `x-cron-secret` and `x-required-rollout-mode` headers and the
per-UTC-hour idempotency key the target routes require, so a job never
gets rejected the way an inline `curl` invocation would. Its non-secret
env is `TARGET_BASE_URL` (the web app's own FQDN), `SCHEDULED_ROUTE`
(`/api/agent/run` for the hourly job, `/api/agent/daily-summary` for the
daily job), and `ROLLOUT_MODE` — `release.bicep` always sets `disabled`;
`rollout.bicep` sets it to whatever `rolloutMode` parameter that deploy
was given so it always matches what that same deploy just set on the web
app. Its only secret is `CRON_SECRET`, granted to the scheduler identity
and nothing else.

## Five separate manual operations jobs

`release.bicep` deploys **five** distinct Container Apps Jobs — not one
generic ops job — each running `npm run azure:ops-job` with a fixed
`OPERATION` value and only the Key Vault secrets that one operation reads
(see [`scripts/azure/ops-job.ts`](../scripts/azure/ops-job.ts) and
`scripts/azure/operations/*.ts`). All five currently share the ops
identity (see "Design limitations" below), but each job resource's own
env/secret list is narrowed independently:

| Job | `OPERATION` | Extra non-secret env | Secret env |
|---|---|---|---|
| `migrate-init` | `migrate-init` | `AZURE_RUNTIME_LOGIN_ROLE` | `DIRECT_URL`, `DATABASE_URL`, `AZURE_RUNTIME_LOGIN_PASSWORD` |
| `preflight` | `preflight` | — | `DATABASE_URL`, `DIRECT_URL` |
| `verified-backup` | `verified-backup` | — | `DATABASE_URL`, `DIRECT_URL` |
| `target-smoke` | `target-smoke` | `TARGET_BASE_URL`, `TARGET_CONFIRM_HOST`, `IMAGE_DIGEST`, `ROLLOUT_MODE=disabled`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_DEPLOYMENT`, `ANTHROPIC_FOUNDRY_API_VERSION`, `POSTHOG_HOST` | `CRON_SECRET`, `ADMIN_PASSWORD`, `DIRECT_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `POSTHOG_API_KEY`, `DEPLOYMENT_APPROVAL_SECRET` |
| `activation-check` | `activation-check` | `TARGET_ORIGIN`, `IMAGE_DIGEST` | `CRON_SECRET`, `DIRECT_URL`, `DEPLOYMENT_APPROVAL_SECRET` |

`DEPLOYMENT_APPROVAL_SECRET` (Key Vault secret `deployment-approval-secret`,
`@secure() param deploymentApprovalSecret`) is granted to the ops identity
and mounted **only** on `target-smoke` and `activation-check` — never on
`migrate-init`, `preflight`, `verified-backup`, the web app, or the
scheduler jobs, none of which need it. It validates that a `target-smoke`
or `activation-check` invocation is an authorized part of a real
deploy/rollout rather than an arbitrary manual trigger. The CI/CD
workflows that invoke these two jobs are being updated to supply it; the
`.bicepparam` files read it from `DEPLOYMENT_APPROVAL_SECRET_DEV`/`_PROD`
with no fallback (see "Secure parameters" below).

All five also receive `ENVIRONMENT_NAME`, `RELEASE_SHA`,
`EVIDENCE_CONTAINER_URL`, and `AZCOPY_MSI_CLIENT_ID` as non-secret env (see
[`scripts/azure/lib/report-path.ts`](../scripts/azure/lib/report-path.ts) /
[`evidence-upload.ts`](../scripts/azure/lib/evidence-upload.ts)).
`AZCOPY_MSI_CLIENT_ID` is the ops identity's client ID (`opsIdentityClientId`,
an `environment.bicep` output): the ops scripts invoke AzCopy as a
subprocess for evidence/backup transfer and set
`AZCOPY_AUTO_LOGIN_TYPE=MSI`, which needs an explicit client ID to
disambiguate which identity to authenticate as — the jobs remain
`UserAssigned`-only (no `SystemAssigned` identity is enabled anywhere in
this template) and no secret is added to grant this; it is a nonsecret
identity property, not a credential.
`target-smoke`'s "target host" env var is the real code's
`TARGET_CONFIRM_HOST` (not `TARGET_HOST`), and its database URL env var is
named `DIRECT_URL` even though the operation's own source reads it into a
locally-named `databaseUrl` variable — both are called out explicitly in
`release.bicep`'s inline comments because the names are easy to get wrong
by inference alone.

`target-smoke` runs `src/deployment/target-smoke.ts`'s `runTargetSmoke()`,
which (a) hard-requires `ROLLOUT_MODE=disabled` in its own process
environment before it will run at all, and (b) calls
`runProviderSmoke()` (see `src/deployment/provider-smoke.ts`), which
directly exercises the Foundry LLM (`smokeFoundry()`, via
`src/agent/llm.ts` / `src/lib/config.ts`'s `resolveFoundryConfig()`) and
PostHog (`smokePostHog()`) providers — so this one job also needs the
same nonsecret Foundry/PostHog config the web app gets
(`ANTHROPIC_FOUNDRY_BASE_URL`/`DEPLOYMENT`/`API_VERSION`, `POSTHOG_HOST`)
plus the `ANTHROPIC_FOUNDRY_API_KEY`/`POSTHOG_API_KEY` secrets. It still
never receives `RESEND_API_KEY`, which no operation reads.

`migrate-init` runs `drizzle-kit migrate` and `scripts/seed.ts` (both
against `DIRECT_URL`; `scripts/seed.ts`'s account-init path also reads
`DATABASE_URL`), and additionally is the one job responsible for the
fresh-deployment Azure runtime login role bootstrap (see
[`src/deployment/bootstrap-runtime-role.ts`](../src/deployment/bootstrap-runtime-role.ts)):
it creates/rotates the `AZURE_RUNTIME_LOGIN_ROLE`-named login role's
password (`AZURE_RUNTIME_LOGIN_PASSWORD`) and grants it
`krypto_runtime` group-role membership. `AZURE_RUNTIME_LOGIN_ROLE` is
nonsecret (a role name, default `krypto_app`, set by the
`runtimeDatabaseLoginRole` parameter); `AZURE_RUNTIME_LOGIN_PASSWORD` is a
`@secure()` parameter (`runtimeDatabasePassword`) stored as the
`runtime-database-password` Key Vault secret and granted to the ops
identity — this is the one secret granted only for `migrate-init`'s
benefit, never mounted on any other job.

**`JOB_EXECUTION_ID` is never given a committed value.** It has no
meaningful static default — `scripts/azure/lib/report-path.ts` uses it to
build an immutable, collision-proof evidence destination path — so it must
be supplied per-invocation:

```bash
az containerapp job start \
  --name <job-name-from-release.bicep-output> \
  --resource-group <rg> \
  --env-vars JOB_EXECUTION_ID=<unique-value-you-generate-per-run>
```

A fake committed value would defeat the immutability guarantee that env
var exists for.

`release.bicep` outputs all five job names (`migrateInitJobName`,
`preflightJobName`, `verifiedBackupJobName`, `targetSmokeJobName`,
`activationCheckJobName`), plus `hourlyJobName`/`dailyJobName` for the
scheduler jobs.

## Secure parameters — fail closed, not fail open

No secret value is ever committed to this repo, and a **missing** secret
value must **fail the deployment**, never silently substitute a
placeholder that would overwrite Key Vault or PostgreSQL with junk:

- **`environment.bicep`**: `postgresAdministratorLoginPassword` is a
  `@secure()` parameter with no default. The paired `.bicepparam` file
  reads it via `readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD_DEV')` /
  `readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD_PROD')` — **with no
  fallback default**. If that environment variable is unset,
  `az bicep build-params` / `az deployment group create` fails loudly
  (Bicep error `BCP427`) instead of deploying a
  known/guessable/placeholder password.
- **`release.bicep`**: `databaseUrl`, `directUrl`, `cronSecret`,
  `anthropicFoundryApiKey`, `posthogApiKey`, `resendApiKey`,
  `adminPassword`, and `adminSessionSecret` are all `@secure()` parameters
  with no defaults, read the same fail-closed way from `DATABASE_URL_DEV`,
  `DIRECT_URL_DEV`, etc. (see `params/release.*.bicepparam` for the exact
  names). `release.bicep` writes these into Key Vault as
  `Microsoft.KeyVault/vaults/secrets` resources; it is the **only**
  template that creates or updates secret values.
- **`rollout.bicep`** never touches a secret value — it reads the
  already-existing Key Vault secrets by name (`existing` resources) to
  wire their versionless URIs into the web app / scheduler jobs, so
  promoting rollout state never requires re-supplying any secret.

Every `.bicepparam` file in `params/` is nonsecret and safe to commit: no
literal secret value, and no fail-open placeholder default, appears in any
of them.

**CI/local template-compile-only validation** (i.e. `az bicep
build-params`, which needs `readEnvironmentVariable()` calls to resolve to
*something* to type-check, but never actually deploys) must export
throwaway stub values for the required environment variables in the
invoking shell — never commit a stub value into a `.bicepparam` file, and
never reuse a real value for this purpose:

```bash
DATABASE_URL_DEV=stub DIRECT_URL_DEV=stub CRON_SECRET_DEV=stub \
ANTHROPIC_FOUNDRY_API_KEY_DEV=stub POSTHOG_API_KEY_DEV=stub \
RESEND_API_KEY_DEV=stub ADMIN_PASSWORD_DEV=stub ADMIN_SESSION_SECRET_DEV=stub \
RUNTIME_DATABASE_PASSWORD_DEV=stub DEPLOYMENT_APPROVAL_SECRET_DEV=stub \
POSTGRES_ADMIN_PASSWORD_DEV=stub \
  az bicep build-params --file infra/params/release.dev.bicepparam
```

## Outputs

`bootstrap.bicep` outputs the two resource group names and, for each of
the four identities, its `clientId`/`principalId`/resource ID — wire
`clientId` into the matching GitHub Environment's `AZURE_CLIENT_ID`
variable (plus your tenant/subscription ID) for the `azure/login` OIDC
action.

`environment.bicep` outputs everything `release.bicep` and `rollout.bicep`
need as inputs: `acrLoginServer`, `containerAppsEnvironmentId`,
`keyVaultName`, **`evidenceContainerUrl`** (the full bare HTTPS evidence
container URL, e.g. `https://stkryptodevevid.blob.core.windows.net/evidence`
— no credential or query string embedded, since every ops job authenticates
with its managed identity via `azcopy login --identity`), and the
runtime/scheduler/ops identity resource IDs, principal IDs, and client IDs
(including `opsIdentityClientId`, wired to every ops job's
`AZCOPY_MSI_CLIENT_ID` env var). It also outputs
`evidenceImmutabilityRetentionDays` — the retention period actually
deployed on the evidence container's (unlocked) immutability policy, for
operator verification before performing the manual, irreversible lock
step described above. Copy these
into the corresponding `REPLACE_WITH_ENVIRONMENT_OUTPUT_*` placeholders in
`params/release.*.bicepparam` / `params/rollout.*.bicepparam` (or resolve
them in a deploy pipeline with `az deployment group show --query
properties.outputs`).

`release.bicep` outputs the web app's FQDN and all seven job names (two
scheduler + five manual operations). `rollout.bicep` outputs the same FQDN
plus the rollout mode and both trigger types it just set, so a deploy log
is sufficient evidence of what changed.

## Secret payloads are supplied at deploy time

Nothing in this tree assumes or invents a real secret, subscription ID, or
approved model capacity number. Every `.bicepparam` file either:

- reads a secret from an environment variable via
  `readEnvironmentVariable('X')` with **no default** — a missing variable
  fails the deployment, it does not silently substitute anything — or
- carries an explicit `REPLACE_WITH_...` token for values that depend on a
  prior deployment's output or on operator/reviewer-approved configuration
  (model name/version/capacity, image digests, resource IDs, the git
  commit SHA, the platform resource group name).

Populate the real values only in your deployment pipeline's environment,
in a secret manager, or via `--parameters` on the command line — never by
editing a real secret into the committed `.bicepparam` files.

## Least-privilege identity design

Three application-facing user-assigned identities exist per environment
(created in `environment.bicep`, RBAC-bound to secrets in `release.bicep`):

| Identity | Used by | Key Vault secrets granted | Other RBAC |
|---|---|---|---|
| runtime | web Container App | `DATABASE_URL`, `CRON_SECRET`, `ANTHROPIC_FOUNDRY_API_KEY`, `POSTHOG_API_KEY`, `RESEND_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` (never `DIRECT_URL`) | `AcrPull` on the environment's ACR |
| scheduler | hourly agent-run + daily summary jobs | `CRON_SECRET` only | `AcrPull` |
| ops | five manual operations jobs (migrate-init, preflight, verified-backup, target-smoke, activation-check) | `DATABASE_URL`, `DIRECT_URL`, `CRON_SECRET`, `ADMIN_PASSWORD` (every job); `ANTHROPIC_FOUNDRY_API_KEY`, `POSTHOG_API_KEY` (target-smoke's provider smoke test only); `deployment-approval-secret`/`DEPLOYMENT_APPROVAL_SECRET` (target-smoke and activation-check only); `runtime-database-password`/`AZURE_RUNTIME_LOGIN_PASSWORD` (migrate-init's runtime login role bootstrap only) — never `RESEND_API_KEY` or `ADMIN_SESSION_SECRET`, which no operation reads. The identity's own Key Vault RBAC is the union of what any one of the five jobs needs; each job resource's own mounted env is narrowed further to just what that one operation reads (see the table above). | `AcrPull`, `Storage Blob Data Contributor` scoped to the evidence **container** (not the storage account — see below) |

Every Key Vault role assignment is scoped to the individual secret
resource (`Microsoft.KeyVault/vaults/secrets/<name>`), not the vault as a
whole, using the built-in `Key Vault Secrets User` role and the
**versionless** `.properties.secretUri` (not `.properties.secretUriWithVersion`)
so Container Apps resolves the latest secret version on rotation without
requiring a template redeploy.

Four more identities exist for CI/CD only (created in `bootstrap.bicep`) —
see "GitHub Environments and OIDC identities" above. Those CI/CD
identities are also the only principals granted `evidenceReaderPrincipalIds`
access in `environment.bicep`: a container-scoped, read-only
`Storage Blob Data Reader` role assignment on the evidence container (not
the whole storage account, and never write/delete), so a GitHub Actions
workflow can `az storage blob download --auth-mode login` a versioned
ops-job report after `release.bicep`'s manual jobs produce one. This is a
separate grant from the ops identity's `Storage Blob Data Contributor`
role above — the ops identity runs inside the Container Apps Job and
writes evidence; the CI/CD identity runs in the GitHub Actions runner and
only ever needs to read it back out.

### Evidence container: container-scoped RBAC and immutability policy

The ops identity's `Storage Blob Data Contributor` grant is scoped to the
evidence **container** resource
(`Microsoft.Storage/storageAccounts/blobServices/containers/evidence`),
not the storage account, and the role assignment is created in
`modules/storage.bicep` (which creates the container it targets),
alongside the CI/CD readers' assignments — not in `modules/identities.bicep`
(which creates the ops identity itself but no longer references storage
at all). `environment.bicep` wires `identities.outputs.opsIdentityPrincipalId`
into `storage.bicep`'s `opsIdentityPrincipalId` parameter, so `identities`
deploys first and `storage` depends on it — a one-directional dependency,
not a cycle. The ops identity has no access to, and cannot even enumerate,
any other container that might exist on this storage account in the
future.

The evidence container also carries a time-based retention (WORM)
immutability policy (`modules/storage.bicep`'s `immutabilityRetentionDays`
parameter, wired from `environment.bicep`'s
`evidenceImmutabilityRetentionDays`, default `35` days, dev set to `7`,
prod set to `90` — production must stay `>=35` per the approved
evidence-retention plan). **This Bicep template can only create or extend
an *unlocked* policy** — the `ImmutabilityPolicyProperty` schema exposes
only `immutabilityPeriodSinceCreationInDays` and the
`allowProtectedAppendWrites*` flags, with no "locked" property to set
declaratively. Locking a policy is a separate, one-time REST POST action
(`.../immutabilityPolicies/default/lock`, e.g.
`az storage container immutability-policy lock`), not an ARM/Bicep
resource property, so **no template in this tree can lock the policy as
part of a deployment** — it is a required manual follow-up step for
production, performed once outside of any template.

This does not weaken the protection: per
[Microsoft's documentation](https://learn.microsoft.com/azure/storage/blobs/immutable-storage-overview),
a time-based retention policy blocks blob overwrite/delete for *every*
principal — including the ops identity — from the moment it is deployed,
whether or not it has been locked yet. Locking only changes two things:
(1) the policy itself can no longer be shortened or deleted by a
principal with `immutabilityPolicies` control-plane rights (which the ops
identity's `Storage Blob Data Contributor` role does **not** grant — that
role's control-plane actions are limited to `containers/read|write|delete`,
not the `immutabilityPolicies` child resource); and (2) once locked, the
retention period can only be increased (up to five times at the container
level), never decreased, and the container itself can only be deleted
once it is empty. **Locking is irreversible** — treat it as a deliberate,
audited, one-time production action, not something to script casually or
repeat per deployment. See the "Evidence container immutability" comment
block in `modules/storage.bicep` for the full explanation.

## Production defaults

- `release.bicep` always deploys the web app with `ROLLOUT_MODE=disabled`
  and both scheduler jobs with `triggerType: Manual`, regardless of what
  parameters are passed — this is hardcoded, not parameterized, so a
  release deploy cannot accidentally activate trading or a schedule.
- `params/rollout.prod.bicepparam` commits `rolloutMode = 'disabled'`,
  `hourlyTriggerType = 'Manual'`, `dailyTriggerType = 'Manual'` as its
  checked-in defaults. Promotion is a `--parameters` override at deploy
  time, reviewed separately — the committed file itself must keep
  shipping the disabled/manual defaults.
- The hourly job's schedule is fixed at cron `0 * * * *` (UTC) with a
  replica retry limit of 1; the daily job's schedule is fixed at cron
  `5 0 * * *` (UTC) with a replica retry limit of 0. These are hardcoded
  in both `release.bicep` and `rollout.bicep`, not parameters, so
  `rollout.bicep`'s only variable surface is `rolloutMode` and the two
  trigger types.
- Production-only hardening: Key Vault purge protection; `CanNotDelete`
  resource locks on the PostgreSQL Flexible Server, Key Vault, and
  evidence storage account; and geo-redundant PostgreSQL backup
  (`geoRedundantBackupEnabled: true` for prod, `false` for dev — this is a
  creation-time-only Postgres Flexible Server property, so it cannot be
  toggled after the fact by a later deploy). High availability remains
  off in both environments. All conditioned on `environmentName == 'prod'`
  in `environment.bicep`.

## Validation

Every entry point and module builds clean with the Azure CLI's bundled
Bicep compiler (0.43.8 at the time this was written) with zero warnings or
errors:

```bash
az bicep build --file infra/bootstrap.bicep
az bicep build --file infra/platform.bicep
az bicep build --file infra/environment.bicep
az bicep build --file infra/release.bicep
az bicep build --file infra/rollout.bicep
for f in infra/modules/*.bicep; do az bicep build --file "$f"; done
```

The nonsecret `.bicepparam` files build standalone once the (non-default)
`readEnvironmentVariable()` calls resolve — export throwaway stub values
for the relevant environment variables first (see "Secure parameters"
above), never real secrets:

```bash
POSTGRES_ADMIN_PASSWORD_DEV=stub POSTGRES_ADMIN_PASSWORD_PROD=stub \
DATABASE_URL_DEV=stub DIRECT_URL_DEV=stub CRON_SECRET_DEV=stub \
ANTHROPIC_FOUNDRY_API_KEY_DEV=stub POSTHOG_API_KEY_DEV=stub \
RESEND_API_KEY_DEV=stub ADMIN_PASSWORD_DEV=stub ADMIN_SESSION_SECRET_DEV=stub \
RUNTIME_DATABASE_PASSWORD_DEV=stub DEPLOYMENT_APPROVAL_SECRET_DEV=stub \
DATABASE_URL_PROD=stub DIRECT_URL_PROD=stub CRON_SECRET_PROD=stub \
ANTHROPIC_FOUNDRY_API_KEY_PROD=stub POSTHOG_API_KEY_PROD=stub \
RESEND_API_KEY_PROD=stub ADMIN_PASSWORD_PROD=stub ADMIN_SESSION_SECRET_PROD=stub \
RUNTIME_DATABASE_PASSWORD_PROD=stub DEPLOYMENT_APPROVAL_SECRET_PROD=stub \
  bash -c 'for f in infra/params/*.bicepparam; do az bicep build-params --file "$f"; done'
```

This repository does not deploy any of these templates and does not have
Azure credentials configured for this task — validation above is
compile-time only (ARM template synthesis + Bicep's built-in type
checking against the resource provider schemas bundled with the CLI). No
`az deployment ... what-if` or `az deployment ... create` has been run
against a real subscription.

## API versions

All resource types use the latest **stable** (non-preview) API version
available in Azure CLI 2.77.0 / Bicep 0.43.8 at authoring time:
`Microsoft.App/managedEnvironments|containerApps|jobs@2025-01-01`,
`Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01`,
`Microsoft.KeyVault/vaults(/secrets)@2024-11-01`,
`Microsoft.Storage/storageAccounts(/blobServices/containers)@2023-05-01`,
`Microsoft.ContainerRegistry/registries@2025-04-01`,
`Microsoft.Network/virtualNetworks(/subnets)@2025-01-01`,
`Microsoft.Network/privateDnsZones(/virtualNetworkLinks)@2024-06-01`,
`Microsoft.OperationalInsights/workspaces@2025-02-01`,
`microsoft.insights/actiongroups@2023-01-01`,
`Microsoft.ManagedIdentity/userAssignedIdentities(/federatedIdentityCredentials)@2024-11-30`,
`Microsoft.Authorization/roleAssignments@2022-04-01`,
`Microsoft.Authorization/locks@2020-05-01`,
`Microsoft.CognitiveServices/accounts(/deployments)@2025-06-01`,
`Microsoft.Resources/resourceGroups@2025-04-01`.

## Design limitations

- **The ops identity is shared across all five manual operations jobs,
  for now.** Each job's own env/secret list is narrowed to only what that
  one operation reads (see the table above), and the identity itself has
  the union of every secret at least one of the five jobs needs (seven
  now that target-smoke's provider-smoke secrets and migrate-init's
  runtime-login-password are included) — never the two runtime-only
  secrets no operation reads (`RESEND_API_KEY`, `ADMIN_SESSION_SECRET`).
  A fully per-job identity (five separate managed identities, each with
  exactly the secrets its own job needs) would be strictly narrower
  still, but was judged unnecessary additional operational surface at
  this stage since every job's Key Vault RBAC is already scoped
  per-secret, not per-vault, and each job resource's own mounted env is
  independently narrowed regardless of what the shared identity's Key
  Vault RBAC permits; a future refinement could split it further if
  desired.
- **`rollout.bicep` requires the caller to repeat the currently-released
  image digest and Foundry/PostHog/alert config exactly.** It re-declares
  the web app and scheduler jobs (Bicep is declarative; there is no
  partial "patch only this field" primitive), so an operator who supplies
  a different `imageDigest` here than what `release.bicep` last deployed
  will silently roll that revision back/forward as a side effect of a
  rollout-mode change. The template comments and `.bicepparam` files call
  this out; a follow-up (not in scope here) could reduce this risk by
  having a deploy pipeline read `release.bicep`'s last output and
  interpolate it automatically rather than relying on operator
  transcription.
- **`platform.bicep` is deployed once, not as a dev/prod pair.** Because
  dev and prod share the same existing Foundry account's quota/key
  boundary (ADR 0008 item 7), the template declares both environments'
  model deployments in one deploy into the account's own resource group.
  Only one `params/platform.bicepparam` exists, not a dev/prod pair, for
  this reason — flagging it explicitly since every other per-environment
  template does get a dev/prod pair.
- **`platform.bicep`'s resource group is assumed pre-existing and must be
  supplied by the operator.** `bootstrap.bicep`'s `platformResourceGroupName`
  parameter has no default; nothing in this tree creates or manages that
  resource group's lifecycle beyond scoping the platform OIDC identity
  into it.
- **Container Apps environment is not fully private.** Only PostgreSQL is
  required to have no public endpoint (ADR 0008 item 2); the Container
  Apps managed environment is VNet-integrated (so it can reach the
  private PostgreSQL subnet) but keeps external ingress enabled on the web
  app, per the ticket's "external Next.js Container App" requirement and
  the ADR's silence on making the app itself private.
- **Key Vault and evidence storage keep `publicNetworkAccess: Enabled`**
  (with `AzureServices` bypass on their network ACLs). The ticket did not
  require private endpoints for these two resources (only PostgreSQL), so
  they are reachable over the public plane but authorize every data
  operation through Azure RBAC (`enableRbacAuthorization: true` on the
  vault; `allowSharedKeyAccess: false` and `allowBlobPublicAccess: false`
  on the storage account) rather than a shared key or access policy.
- **The evidence container's immutability policy cannot be locked by any
  template in this tree.** `modules/storage.bicep` deploys a time-based
  retention policy (`immutabilityRetentionDays`, prod default 90 days,
  must stay `>=35`) that already blocks blob overwrite/delete for every
  principal — including the container-scoped ops identity — the moment it
  is deployed. But Azure's `ImmutabilityPolicyProperty` ARM schema has no
  "locked" property; locking is only exposed as a one-time REST POST
  action (e.g. `az storage container immutability-policy lock`), which is
  not expressible as a declarative Bicep resource. Until an operator runs
  that command by hand against production, the deployed policy remains
  *unlocked*: still fully enforced against overwrite/delete, but a
  principal with `immutabilityPolicies` control-plane rights (which
  neither the ops identity's nor any other RBAC grant in this tree
  includes) could still shorten or remove the policy itself. Locking is
  irreversible and, once locked, retention can only be increased (up to
  five times) and the container can only be deleted once empty — treat it
  as a deliberate one-time production action, not part of any repeatable
  deploy.
- **`evidenceReaderPrincipalIds` is a manual cross-template hand-off, not
  an automatic wiring.** `environment.bicep` cannot reference
  `bootstrap.bicep`'s outputs directly (they are separate deployments at
  different scopes), so `environment.dev.bicepparam` and
  `environment.prod.bicepparam` carry `REPLACE_WITH_BOOTSTRAP_..._PRINCIPAL_ID`
  placeholders that an operator must fill in with the real
  `devIdentityPrincipalId` / `prodDeployIdentityPrincipalId` /
  `prodPromotionIdentityPrincipalId` values after running
  `bootstrap.bicep` once, before deploying `environment.bicep`. Left
  empty (`[]`), no CI/CD identity gets evidence-container read access and
  the ops-report-download workflow step would fail with an authorization
  error, not silently succeed. A future refinement could look these
  values up automatically via `existing` resource references scoped by
  a well-known identity name pattern, but that was judged out of scope
  here to avoid a template-to-template naming-convention coupling.
- **No live-trading changes.** This tree only ever sets `ROLLOUT_MODE` to
  `disabled`, `shadow`, or `paper` — never anything implying real
  execution — consistent with v2 being paper-trading-only and with there
  being no accepted v3 live-trading RFC/release plan referenced here.
