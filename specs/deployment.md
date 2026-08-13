# Deployment Runbook (Azure)

> **Implemented, not yet provisioned.** This is the Azure-native runbook
> accepted in ADR
> [`0008-azure-native-deployment-architecture.md`](./decisions/0008-azure-native-deployment-architecture.md)
> (Azure Container Apps + Jobs, Azure Database for PostgreSQL Flexible
> Server 17 on private VNet access, Key Vault, a per-environment Azure
> Container Registry, Bicep, GitHub Actions OIDC). The Bicep templates
> (`infra/`), the GitHub Actions workflows below, and the application-side
> deployment code (`src/deployment/`, `scripts/azure/`) all exist in this
> repository and are validated locally (Bicep compiles clean, ops-job unit
> tests pass — see `infra/README.md` "Validation"). An Azure subscription
> and existing Foundry service(s) are available, but **no Project Krypto
> Azure resource group or environment has been provisioned from this code,
> and no deploy/what-if has ever targeted the new stack.** Every step below is unexercised outside local
> compile-time validation until an operator completes the one-time
> bootstrap in §1 and the first dev/prod deploys succeed. Do not treat any
> statement in this document as evidence that a deploy has occurred.
>
> The historical Vercel + Supabase runbook this replaces is preserved,
> unmodified except for its archive banner, at
> [`specs/archive/deployment.vercel-supabase.md`](./archive/deployment.vercel-supabase.md).
> Do not use it to start a new Vercel/Supabase production deployment.
>
> For the full infrastructure design (identity model, secret handling,
> job layout, API versions, known design limitations) see
> [`infra/README.md`](../infra/README.md) — this document is the
> operational sequence for using that infrastructure, not a restatement
> of its design.
> Current-vs-target diagrams, planned resource names, and safe operator
> links are maintained in [`architecture.md`](./architecture.md).
>
> **Paper/live safety gates are unchanged by this platform migration.**
> `ROLLOUT_MODE` still governs `disabled` / `shadow` / `paper` only; no
> workflow here can enable live trading. The v2.1/v2.2/v3 release gates in
> [`specs/readiness.md`](./readiness.md) §4 and the authorization rules in
> [`production-readiness-prd.v1.md`](./production-readiness-prd.v1.md)
> remain authoritative and are not satisfied by a passing Azure deploy —
> a disabled-mode deploy proves the deploy mechanism works, not that
> promotion criteria are met.

---

## 0. Terminology

- **Implementation-complete**: the Bicep templates, GitHub Actions
  workflows, and application ops-job code exist, compile, and pass their
  local/unit tests.
- **Provisioning/evidence pending**: the Azure subscription and existing
  Foundry service predate this work, but no Project Krypto Azure resource group,
  identity, database, or Container App has ever been created from this
  code, and no ops-job or target-smoke report has ever been produced
  against a live target. Both are true simultaneously today.

---

## 1. One-time local bootstrap

Before any GitHub Actions workflow can run, an operator with subscription
Owner/Contributor access must deploy `bootstrap.bicep` **once**, from a
local shell with the Azure CLI and `az login` (not from CI — this step
creates the very identities CI later authenticates as):

```bash
az deployment sub create \
  --location eastus2 \
  --template-file infra/bootstrap.bicep \
  --parameters infra/params/bootstrap.bicepparam
```

Before running it, edit `infra/params/bootstrap.bicepparam` and replace
`platformResourceGroupName`'s `REPLACE_WITH_EXISTING_PLATFORM_RESOURCE_GROUP_NAME`
placeholder with the real name of the resource group that already holds
the existing Microsoft Foundry account (this template does not create
that resource group). See `infra/README.md` "GitHub Environments and OIDC
identities" for what this deploy creates: the `dev` and `prod` resource
groups, and four GitHub OIDC-federated user-assigned identities (`dev`,
`prod deploy`, `prod promotion`, `platform`), each scoped to exactly one
resource group.

Record this deploy's outputs (`az deployment sub show --query
properties.outputs`): the two resource group names and each identity's
`clientId`/`principalId`. They feed directly into §2 and §3. Re-run this
step only if the repo/org name or a GitHub Environment name changes.

---

## 2. Required GitHub Environments, variables, and secrets

Four GitHub Environments must exist before any Azure workflow can run,
matching the four identities `bootstrap.bicep` just created. Each
Environment should have required reviewers configured (branch
restrictions optional beyond the default `main`/`develop` split already
enforced by the workflow triggers).

| GitHub Environment | Federated identity | Used by | Required repository/environment variables | Required environment secrets |
|---|---|---|---|---|
| `platform` | platform | `azure-platform.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | none (model inputs are workflow_dispatch inputs, not secrets) |
| `development` | dev | `azure-deploy-dev.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `DEV_RESOURCE_GROUP_NAME`, `DEV_IDENTITY_NAME`, `FOUNDRY_RESOURCE_NAME` | `POSTGRES_ADMIN_PASSWORD`, `DATABASE_URL`, `DIRECT_URL`, `CRON_SECRET`, `ANTHROPIC_FOUNDRY_API_KEY`, `POSTHOG_API_KEY`, `RESEND_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `RUNTIME_DATABASE_PASSWORD`, `DEPLOYMENT_APPROVAL_SECRET` |
| `production-deploy` | prod deploy | `azure-deploy-prod.yml`, `azure-rotate-secrets.yml` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PROD_RESOURCE_GROUP_NAME`, `PROD_DEPLOY_IDENTITY_NAME`, `PROD_PROMOTION_IDENTITY_NAME`, `FOUNDRY_RESOURCE_NAME` | same secret names as `development`, using prod values |
| `production-promotion` | prod promotion | `azure-deploy-prod.yml` (force-disable step only), `azure-promote-prod.yml`, `azure-rotate-secrets.yml` (disable step only) | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PROD_RESOURCE_GROUP_NAME`, `PROD_PROMOTION_IDENTITY_NAME`, `FOUNDRY_RESOURCE_NAME` | none — `rollout.bicep` never reads a secret |

Each `AZURE_CLIENT_ID` is the matching identity's `clientId` from §1's
bootstrap output — **do not** reuse the same client ID across
Environments; each Environment gets its own identity, which is exactly
how the resource-group isolation in `infra/README.md`'s GitHub
Environments table is enforced.

The `DEPLOYMENT_APPROVAL_SECRET` stored independently in the `development`
and `production-deploy` GitHub Environments is distinct from `CRON_SECRET`.
Each workflow maps it to the internal
`DEPLOYMENT_APPROVAL_SECRET_DEV`/`DEPLOYMENT_APPROVAL_SECRET_PROD` variable
that its `.bicepparam` file reads. Bicep binds it
only into the **`target-smoke`** and **`activation-check`** ops-job
definitions for its environment (never `preflight`, `migrate-init`,
`verified-backup`, and never the web/runtime Container App revision).
Those two jobs use it as HMAC-SHA256 key material to sign the approval
that binds a passing evidence report to the specific release/cron
activation it approves — see §6 and §7.

A fifth environment, `production-smoke`, is used only by the separate,
non-Bicep `foundry-smoke.yml` workflow (manual, protected, no-trade LLM
connectivity check) — it takes plain repository secrets
(`ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`,
`ANTHROPIC_FOUNDRY_DEPLOYMENT`), not an OIDC identity, and is unrelated to
the four bootstrap identities above.

### 2a. Azure PostgreSQL credential contract

The initial Azure target uses Flexible Server's default `postgres` database.
`DATABASE_URL` and `DIRECT_URL` target that same private server/database but
must use distinct roles:

| Secret | Username | Required relationship |
|---|---|---|
| `DIRECT_URL` | `krypto_owner` | Its password equals `POSTGRES_ADMIN_PASSWORD`; only ops jobs receive it |
| `DATABASE_URL` | `krypto_app` | Its password equals `RUNTIME_DATABASE_PASSWORD`; the web app receives only this URL |

Both URLs include `sslmode=require`. `migrate-init` first connects through
`DIRECT_URL`, applies migrations, creates/rotates `krypto_app` from
`RUNTIME_DATABASE_PASSWORD`, then initializes the singleton through
`DATABASE_URL`. Preflight proves the two connections reach the same cluster
while using distinct current users. GitHub-hosted runners never connect
directly to this private database.

---

## 3. Foundry capacity review (`azure-platform.yml`)

`platform.bicep` is deployed once (not per dev/prod pair — see
`infra/README.md` "Design limitations") into the existing Foundry
account's resource group, using the `platform` Environment.
`azure-platform.yml` is `workflow_dispatch`-only and takes the Foundry
account name/resource group/region plus dev and prod
model/format/version/SKU/capacity as explicit inputs — nothing is
hardcoded or defaulted. Before deploying, it independently validates
every model/SKU/capacity combination against the **live** Foundry model
catalog and subscription/region quota via
`.github/scripts/azure/validate-model-quota.sh`, and prints the exact
target (account, resource group, region, both deployments) for the
`platform` Environment reviewer to confirm before approving. A failed
quota/catalog check hard-fails the run; there is no fallback
model/SKU/capacity. Re-run only when a model/version/SKU/capacity changes
for either environment.

---

## 4. Dev deploy: `develop` → automatic disabled deploy → auto-promote to shadow

`azure-deploy-dev.yml` runs automatically after a **push-triggered** CI
run succeeds on the exact `develop` branch (never on a `pull_request`-
triggered run, so an unmerged PR head is never deployed), or manually via
`workflow_dispatch` with an explicit commit SHA. It always checks out the
exact commit SHA the triggering CI run validated. Job sequence, each
gated on the previous job succeeding:

1. **`gate`** — resolves and validates the exact 40-hex commit SHA to
   deploy.
2. **`deploy-environment`** (`development` Environment) — renders
   `environment.dev.bicepparam`, runs `az deployment group what-if` on
   `infra/environment.bicep`, hard-rejects any unsafe Delete change via
   `reject-unsafe-whatif-deletes.mjs`, then deploys it and extracts its
   outputs (ACR, Container Apps environment ID, runtime/scheduler/ops
   identity IDs, evidence container URL).
3. **`build-images`** (`development`) — builds the web and ops images via
   `az acr build` and resolves their immutable `sha256` digests (never a
   mutable tag).
4. **`deploy-release`** (`development`) — renders `release.dev.bicepparam`
   with the environment outputs and image digests, then deploys
   `infra/release.bicep`. This always lands with `ROLLOUT_MODE=disabled`
   and both scheduler jobs `Manual` — hardcoded in `release.bicep` itself,
   not a workflow choice.
5. **`ops-validate`** (`development`) — runs `migrate-init` →
   `preflight` → `target-smoke` → `activation-check`, in that order,
   each via the exact ops-job evidence sequence in §6. Evidence is
   downloaded and independently schema/pass/binding-validated after each
   job; a missing output or failed validation stops the workflow.
6. **`promote-shadow`** (`development`) — only if `ops-validate` passed:
   renders `rollout.dev.bicepparam` with `rolloutMode=shadow` and both
   trigger types `Schedule`, runs a what-if with the same unsafe-delete
   rejection, then deploys `infra/rollout.bicep`.

Dev is the one environment where a passing automated pipeline promotes
itself to `shadow` + `Schedule` without a separate manual promotion step —
prod never does this (§7 is always a separate, manually-invoked action).

---

## 5. Prod deploy: successful `main` CI → approved disabled deploy

`azure-deploy-prod.yml` runs automatically after a push-triggered CI run
succeeds on the exact `main` branch, or manually via `workflow_dispatch`.
It **never** promotes to shadow/paper or flips a scheduler trigger to
`Schedule` — every path through this workflow ends with prod
disabled/Manual. Job sequence:

1. **`gate`** — resolves and validates the exact commit SHA (same
   pattern as dev).
2. **`deploy-environment`** (`production-deploy`) — what-if + deploy
   `infra/environment.bicep` for prod, same unsafe-delete rejection as
   dev.
3. **`force-disable-rollout`** (`production-promotion` — a **separate**
   approval gate from step 2's `production-deploy`) —
   - detects whether an existing release is already deployed, by
     checking whether the `caj-prod-preflight` Container Apps Job already
     exists;
   - **if an existing release is detected**: resolves its current
     `RELEASE_SHA` (from the preflight job's own `RELEASE_SHA` env) and
     current web-app image digest, then deploys `infra/rollout.bicep`
     with **no** `--set-string-param` override — the committed
     `rollout.prod.bicepparam` already defaults to
     `rolloutMode=disabled`/both triggers `Manual`, so this deploy can
     only (re)confirm the disabled state, never promote it;
   - **if no existing release is detected** (genuinely fresh
     environment): this whole force-disable deploy is skipped, not
     failed — there is nothing to force back to disabled yet, and the
     workflow never fabricates a "disable" action against a release that
     doesn't exist.
4. **`backup-current-release`** (`production-deploy`) — runs **only if**
   step 3 detected an existing release (`needs.force-disable-rollout.
   outputs.existing_release == 'true'`; explicitly skipped, never
   failed, on a fresh environment). Runs `preflight` then
   `verified-backup` against the **current** (about-to-be-replaced)
   release, each through the §6 evidence sequence, before anything about
   the new release is touched. This is the fresh-vs-existing backup
   logic: a fresh environment has no prior release to back up and skips
   this job entirely; an existing environment always gets a safety
   backup of what's currently live before it's replaced.
5. **`build-images`** (`production-deploy`) — builds and digest-resolves
   the new web/ops images.
6. **`deploy-release`** (`production-deploy`) — deploys
   `infra/release.bicep` for the new release (always
   disabled/Manual — hardcoded).
7. **`migrate-backup-smoke`** (`production-deploy`) — runs `migrate-init`
   → `verified-backup` (a **fresh** baseline backup of the just-migrated
   new release) → `target-smoke` for the new release, each through §6.

Every ops run's evidence in this workflow is downloaded and published as
a workflow artifact. Step 7's `target-smoke` run is the one whose exact
`JOB_EXECUTION_ID` an operator must record and later supply to
`azure-promote-prod.yml` (§7) — it is not looked up automatically.
Promotion to shadow/paper and flipping a scheduler trigger to `Schedule`
is exclusively `azure-promote-prod.yml`'s job (§7) — this workflow cannot
do either.

---

## 6. Ops-job evidence sequence (exact)

Every ops-job invocation anywhere in these workflows — `preflight`,
`migrate-init`, `verified-backup`, `target-smoke`, `activation-check` —
follows the identical three-command sequence, fail-closed at each step:

```bash
# 1. Start the job and poll to a terminal state (fails on Failed/timeout).
job_execution_id="$(azure_new_job_execution_id <operation>)"
.github/scripts/azure/run-ops-job.sh \
  --job-name "<job-name-from-bicep-output>" \
  --resource-group "<rg>" \
  --job-execution-id "${job_execution_id}" \
  --timeout-seconds "${OPS_JOB_TIMEOUT_SECONDS}"   # 1800

# 2. Download the versioned evidence report the job wrote to blob
#    storage, authenticating as the CI/CD OIDC identity (read-only,
#    container-scoped Storage Blob Data Reader — see infra/README.md).
#    The job itself only ever holds container-scoped writer RBAC on the
#    evidence container (never subscription- or account-wide), and the
#    container has a time-based immutability policy — once written, a
#    report can be read but not overwritten or deleted before its
#    retention window expires.
.github/scripts/azure/download-evidence.sh \
  --container-url "<evidence_container_url>" \
  --environment-name <dev|prod> \
  --release-sha "<40-hex-sha>" \
  --operation <operation> \
  --job-execution-id "${job_execution_id}" \
  --destination evidence

# 3. Independently validate the downloaded report's schema, pass/fail
#    field, and (for target-smoke/activation-check) that its bound
#    release SHA and image digest match what this run expects.
node .github/scripts/azure/validate-report.mjs \
  --report "evidence/<env>/<sha>/<operation>/${job_execution_id}/report.json" \
  --operation <operation> \
  --release-sha "<40-hex-sha>" \
  [--image-digest "sha256:<64-hex>"]
```

`JOB_EXECUTION_ID` is always derived from `GITHUB_RUN_ID`/
`GITHUB_RUN_ATTEMPT` (never a free-form workflow input), so it can never
be crafted to collide with or overwrite prior evidence. A missing job
output, an unreadable report, or a validation failure stops the workflow
— nothing here treats "no evidence" as "passed."

`target-smoke` and `activation-check` additionally sign their report
with an HMAC-SHA256 approval computed from the environment's
`DEPLOYMENT_APPROVAL_SECRET` (§2),
binding that specific report to the release/cron activation it approves.
This approval secret is separate from `CRON_SECRET`: it authorizes
*promotion decisions*, `CRON_SECRET` authorizes *scheduled invocation
requests* the running app receives — neither substitutes for the other,
and only these two ops jobs ever see the approval secret. `preflight`,
`migrate-init`, and `verified-backup` never receive it and never produce
a signed approval.

---

## 7. Two-step prod promotion: `prepare` then `activate` (`azure-promote-prod.yml`)

Manual, `workflow_dispatch`-only, always under the `production-promotion`
Environment. This is the **only** workflow that can move prod out of
`disabled` or turn a scheduler trigger to `Schedule`, and it only ever
deploys `infra/rollout.bicep` — never `release.bicep`, never touching
PostgreSQL/Key Vault/evidence storage directly.

Both actions require the exact 40-hex `release_sha`, `sha256:`
`image_digest`, **and** the exact `target_smoke_job_execution_id` of the
specific `target-smoke` run that already produced a **passing** evidence
report for that release/image — the operator supplies this
`JOB_EXECUTION_ID` explicitly (surfaced in `azure-deploy-prod.yml`'s own
run summary/logs when its `target-smoke` step succeeds); promotion never
auto-discovers or falls back to "the newest evidence for this
release/image." A `verify-target-smoke-evidence` job downloads and
independently validates exactly that report, including its
`DEPLOYMENT_APPROVAL_SECRET`-signed HMAC-SHA256 approval, before
either action proceeds — it fails closed on a missing report, an ID that
doesn't match, or an invalid signature.

- **`action=prepare`** (requires `app_mode` = `shadow` or `paper`; `paper`
  additionally requires typing the exact acknowledgement phrase `I
  ACKNOWLEDGE THIS DOES NOT AUTHORIZE LIVE TRADING`):
  1. Deploys `rollout.bicep` with the requested `rolloutMode` and **both**
     trigger types left at their committed `Manual` default, then
     confirms from the deploy's own output that the mode matches the
     request and both triggers are still `Manual` — failing closed if
     either drifted.
  2. `paper` only: runs `preflight` then `verified-backup` for the
     current release (§6 sequence).
  3. Runs `activation-check` (§6 sequence) against the newly-set mode.
  4. Runs exactly **one manual (not scheduled)** execution of the hourly
     agent-run job, proving it behaves correctly bound to the new
     `ROLLOUT_MODE` before any schedule exists.
  5. Exits with both trigger types still `Manual` — `prepare` alone can
     never cause a scheduled trading run, and it never authorizes live
     trading regardless of `app_mode`.
- **`action=activate`** (no `app_mode` input — the currently-deployed live
  mode is used, queried live, never re-supplied):
  1. Re-runs `activation-check` against the currently deployed mode/image.
  2. Deploys `rollout.bicep` again with **only** the two trigger types
     flipped to `Schedule` — every other input (image digest, Foundry
     config, alert emails) must match what's currently deployed, since
     `rollout.bicep` re-declares the whole app/jobs.

`prepare` and `activate` are always separate, separately-invoked runs so
an attended human reviews the `prepare` evidence before deciding to
`activate`. Neither step, nor the `paper_trading_acknowledgement` input,
ever authorizes live-money execution — `paper` mode is paper trading
only.

---

## 8. Secret rotation (`azure-rotate-secrets.yml`)

Manual, `workflow_dispatch`-only, requires the operator to type the
`expected_release_sha` they believe is currently deployed (fails closed
on a mismatch — a safety cross-check, not a target selector). The actual
new secret *values* are never a workflow input: the operator rotates each
secret's value in the `production-deploy` Environment's GitHub secrets
**before** running this workflow; the workflow only ever reads whatever
is currently stored there.

1. **Disable schedules first** (`production-promotion` Environment) —
   deploys `rollout.bicep` with no promote override, same as
   `azure-deploy-prod.yml`'s `force-disable-rollout` job, so this
   workflow pauses for **two** separate Environment approval gates even
   though only `production-deploy` is named as its overall gate.
2. **Redeploy `release.bicep`** (`production-deploy`) with the **same**
   exact currently-deployed image digests (no new build, no release
   change) — only the Key Vault secret values actually rotate, since
   `release.bicep`'s `readEnvironmentVariable()` calls pick up whatever
   is currently in the Environment's secrets.
3. **Rerun `target-smoke`** (§6 sequence) to prove the rotated secrets
   still work.
4. Publish evidence and leave prod exactly where it started:
   disabled/Manual. This workflow never passes a rollout-mode or
   trigger-type override, so it can never re-enable a schedule as a side
   effect of rotation.

---

## 9. Rollback

| Goal | Action |
|---|---|
| Stop all schedules immediately | Deploy `infra/rollout.bicep` (via the `production-promotion` identity, manually or via `azure-rotate-secrets.yml`'s disable step) with both trigger types `Manual`; the committed `params/rollout.prod.bicepparam` already defaults to this |
| Prevent any new orchestration | Confirm `ROLLOUT_MODE=disabled` on the deployed release; a rollout-mode-only change is always a `rollout.bicep` deploy, never a `release.bicep` redeploy |
| Roll back to a prior release | Re-run `azure-deploy-prod.yml` with `workflow_dispatch` and the prior known-good `commit_sha`; it re-runs the full disabled-deploy + evidence sequence against that commit, never skipping gates for a rollback |
| Pause while preserving configuration | Use **Pause Agent** in `/admin` (unchanged from the historical runbook — this is an application-level control, not an Azure control) |
| Retire an environment | Not automated here; requires a separately reviewed decommission procedure (resource group deletion is destructive and is not part of any workflow above) |

Rollback triggers (trade in disabled/shadow, reconciliation failure,
negative/duplicate accounting, stale/overlapping lease, auth/privilege
failure, unsafe/stale market data, consecutive missed/error runs,
prolonged email failure, drawdown lock, credential concern, migration
drift) are unchanged from RFC 0002 and the historical runbook. Preserve
all evidence and record the incident; never reset the ledger to make a
promotion window appear clean.

---

## 10. Paper/live gates are unchanged

Migrating the deployment target to Azure changes **how** a release is
shipped and promoted. It does not change **what** is required before
trading is enabled:

- `ROLLOUT_MODE` still only ever takes `disabled` / `shadow` / `paper`.
  No workflow in this document, and no Bicep template under `infra/`, can
  set it to anything implying live execution.
- The v2.1 safety/correctness gates, v2.2 evidence-grade paper trading
  gates, and v3 live-trading preconditions in
  [`specs/readiness.md`](./readiness.md) §4 are unchanged and remain
  authoritative. A passing Azure disabled-mode deploy or a passing
  `target-smoke` report satisfies deployment-mechanism gates only — it is
  not evidence toward the v2.2/v3 evaluation-window or authorization
  gates.
- [`production-readiness-prd.v1.md`](./production-readiness-prd.v1.md)'s
  ownership, authorization, and gate-threshold rules govern promotion
  decisions regardless of hosting platform.

---

## 11. Further reading

- [`infra/README.md`](../infra/README.md) — full infrastructure design:
  identity/RBAC model, the five manual operations jobs and their exact
  env/secret lists, secure-parameter handling, deployment order,
  API versions, and known design limitations.
- [`architecture.md`](./architecture.md) — current hosted baseline, target
  diagrams, planned dev/prod resources, promotion flow, and operator links.
- `azure-infra-validate.yml` — the PR-facing CI check (triggers on
  `infra/**` changes) that runs template-compile-only `az bicep build` /
  `az bicep build-params` validation with inert stub values; never
  authenticates to Azure. See `infra/README.md` "Validation" for the
  equivalent local commands.
- [`decisions/0008-azure-native-deployment-architecture.md`](./decisions/0008-azure-native-deployment-architecture.md)
  — the accepted architecture decision and its consequences/trade-offs.
- [`specs/readiness.md`](./readiness.md) — current evidence baseline and
  gate disposition.
- [`specs/monitoring.md`](./monitoring.md) — observability signals,
  dashboards, and alert thresholds (platform-agnostic; still applies).
- [`specs/archive/deployment.vercel-supabase.md`](./archive/deployment.vercel-supabase.md)
  — the superseded Vercel/Supabase runbook, kept for historical/safety
  reference only.
