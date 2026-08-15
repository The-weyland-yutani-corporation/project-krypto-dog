# Deployment and trading readiness

> **State snapshot: 2026-08-15 — AZURE RELEASES DEPLOYED.** Dev is
> shadow/scheduled and production is disabled/manual. Exact-SHA migration,
> target smoke, activation, scheduled-run, alert-delivery, and restore-verified
> backup evidence passed.
>
> **Paper/live boundary:** the implemented rollout modes are `disabled`,
> `shadow`, and `paper`. No current workflow, readiness decision, or deployment
> authorizes live-money execution.

The historical hosted baseline is not the Azure release candidate. Its
observations remain historical only; its archived procedure is
[`archive/deployment.vercel-supabase.md`](./archive/deployment.vercel-supabase.md).

## 1. Readiness decision

| Scope | Current decision | Blocking reason |
|---|---|---|
| Azure platform | **Operational fallback ready** | Dev/prod Luna deployments on the established account passed Entra plain and structured `HOLD` smokes; the dedicated account remains model-empty |
| Azure dev | **Deployment-ready in shadow** | First scheduled run passed with zero trades; paper promotion still requires its separate evidence window |
| Azure prod | **Deployment-ready, disabled/manual** | Backup and target smoke passed; no promotion workflow is shipped |
| v2.2 paper rollout | **Not ready** | No 30-day qualifying paper evidence window, separate PostHog projects, or approved production promotion design |
| v3 live execution | **Not authorized** | Live execution is outside the current implementation and requires its own approval gates |

Source implementation, local tests, or a historical provider observation do
not satisfy a live Azure gate.

## 2. Approved target contract

| Control | Required value |
|---|---|
| Runtime-selected subscription | **Visual Studio Enterprise Subscription**; never publish its ID/internal identifiers |
| Region | `westus3` |
| Resource groups | `rg-krypto-platform`, `rg-krypto-dev`, `rg-krypto-prod` |
| Operational Foundry account | `ghcp-foundry-eastus2` until the dedicated account is unblocked |
| Model | OpenAI `gpt-5.6-luna` version `2026-07-09` |
| Deployment SKU/capacity | `GlobalStandard`; desired dev 10 + prod 10, with deployment-pair-aware incremental validation against the exact quota dimension |
| Deployment names | `krypto-dev-luna`, `krypto-prod-luna` |
| Foundry auth | Project Krypto mounts no model API key; runtime and ops UAMIs receive only **Cognitive Services OpenAI User** |
| Deployment mutation scope | All mutation roles are resource-group-scoped; prod-deploy and platform Locks Contributor remain in their respective resource groups |
| Deployment subscription reads | One-action Project Krypto Provider Registration Reader on platform/dev/prod-deploy; Cognitive Services Usages Reader additionally on platform; no broad Reader |
| Runtime model config | `AZURE_OPENAI_BASE_URL` ending `/openai/v1`, `AZURE_OPENAI_DEPLOYMENT_NAME`, `AZURE_CLIENT_ID` |
| Email | Separate dev/prod Azure Communication Services Email resources with Azure-managed domains |
| Analytics | Mandatory `deployment_environment` property now; distinct PostHog projects remain a production-promotion prerequisite |

`eastus2` was rejected because the selected subscription is restricted from
PostgreSQL provisioning there. It is a historical constraint, not a valid
deployment option.

## 3. Implemented workflow surfaces

Six Azure workflow surfaces implement or validate the target:

| Workflow | Responsibility | Current live status |
|---|---|---|
| `azure-infra-validate.yml` | Source validation for Bicep, parameters, workflow contracts, and Azure helper tests | Validation-only; cannot produce live deployment evidence |
| `azure-platform.yml` | Dedicated Foundry account/model plan, apply, exact catalog/quota check, and no-trade smoke | Dedicated account/model attempt failed after account/catalog/quota; operational fallback models and smokes were completed separately |
| `azure-platform-access.yml` | Separate plan/apply for four runtime/ops account-role bindings | Applied; dev/prod runtime and ops each have Cognitive Services OpenAI User |
| `azure-deploy-dev.yml` | Dev `foundation` or `full` release and monitored shadow activation | Live equivalent operator path completed; dev shadow/scheduled |
| `azure-deploy-prod.yml` | Prod `foundation` or `full` release ending disabled/manual | Live equivalent operator path completed; prod disabled/manual |
| `azure-rotate-secrets.yml` | Safe prod secret rotation with current-release disable/backup controls | Not run; production release exists and is currently disabled/manual |

Platform account/model mutation and platform access each use separate
environment-scoped what-if and apply jobs. GitHub Environments, branch
restrictions, and protected values are configured. Required-reviewer rules are unsupported by the private-repo
billing plan, so mutation workflows are manual/paused behind configured branch,
exact-SHA, and CI gates. GitHub-hosted jobs were blocked by the account Actions
billing state during the first release, so the authenticated operator path used
the same reviewed templates and evidence validators. Production deploy remains
disabled manually; the proven dev automatic trigger is configured but cannot
start while the billing block remains.

No executable production promotion workflow is shipped or approved.
`production-promotion` remains only as the environment-scoped forced-disable
identity/environment used within prod deploy and rotation. Any future
production promotion requires a new evidence-bound design and review.

Azure Support API ticket creation for the dedicated-account `715-123420`
failure was unavailable without an eligible support plan. The established
account fallback preserves the exact model/version/SKU/capacity and Entra auth
contract, so it is an approved operational workaround rather than a model or
credential downgrade.

## 4. Mandatory provisioning order

- [x] Select **Visual Studio Enterprise Subscription** at runtime by display
  name; retain no subscription ID in public documentation.
- [x] As an authorized subscription owner, run
  `.github/scripts/azure/register-providers.sh` and wait for every required
  namespace, including `Microsoft.Network`, to reach `Registered`. Deployment
  workflows use `--check-only` and cannot perform this subscription mutation.
- [x] Review and apply `bootstrap.bicep` in `westus3`.
- [x] Verify the custom provider-state role contains only
  `Microsoft.Resources/subscriptions/providers/read` and is assigned only to
  platform/dev/prod-deploy; verify platform additionally has Cognitive Services
  Usages Reader.
- [x] Verify Locks Contributor is scoped to `rg-krypto-platform` for the
  Foundry lock and `rg-krypto-prod` for the prod PostgreSQL, Key Vault, and
  evidence-storage locks.
- [x] Configure `platform`, `development`, `production-deploy`, and the
  forced-disable-only `production-promotion` GitHub Environments, including
  branch restrictions and the currently available protected values. Required
  reviewers are unavailable on the current plan; keep mutation manual/paused.
- [x] Stage a dev telemetry fallback with mandatory
      `deployment_environment=dev`; do not count it as final project isolation.
- [x] Run the Foundry account what-if/apply; verify local auth disabled and the
  `CanNotDelete` lock.
- [x] Prove the exact model catalog match and quota availability for the two
  target deployment-name/capacity pairs. Subtract only exact existing target
  capacity on the same format/model/version/SKU dimension.
- [x] Deploy exact Luna dev/prod fallbacks on the established account after the
      dedicated account returned `715-123420`.
- [x] Pass Entra-authenticated plain-response and strict structured `HOLD`
      smokes against both fallback deployments.
- [x] Deploy the dev foundation.
- [x] Deploy the prod foundation.
- [x] Retain both foundation handoffs and bind the exact dev/prod runtime and
  ops principal IDs through `azure-platform-access.yml`.
- [x] Verify exactly one Cognitive Services OpenAI User assignment per
  workload principal before any full release.

Both foundations are mandatory before the access workflow because the four
principal IDs are created by those foundations. A full release before access
binding is not an approved shortcut.

Any full dev run must remain a manual dispatch at the exact CI-passed 40-hex
SHA while required-reviewer enforcement is unavailable. GitHub evaluates
`workflow_run` with the workflow version on the default branch, but automatic
mutation must remain paused regardless of that trigger behavior.

## 5. Configuration readiness

### GitHub release secrets

Dev and prod require independent values for:

```text
POSTGRES_ADMIN_PASSWORD
DATABASE_URL
DIRECT_URL
CRON_SECRET
POSTHOG_API_KEY
ADMIN_PASSWORD
ADMIN_SESSION_SECRET
RUNTIME_DATABASE_PASSWORD
DEPLOYMENT_APPROVAL_SECRET
```

Current state: runtime secret bindings passed both target smokes. The shared
PostHog key remains environment-tagged deployment evidence only.

Readiness requirements:

- [x] `DATABASE_URL` uses the least-privilege `krypto_app` role.
- [x] `DIRECT_URL` uses `krypto_owner`; both database URLs target the same
  private PostgreSQL 17 database with `sslmode=require`.
- [x] `DEPLOYMENT_APPROVAL_SECRET` differs from `CRON_SECRET`.
- [x] Dev/prod events are query-isolated by mandatory deployment tags.
- [ ] Move dev to a distinct PostHog project before production promotion.
- [x] No long-lived Azure credential or Foundry API key is stored in GitHub.

ACS connection strings are not GitHub secrets or workflow inputs.
`release.bicep` obtains each environment's Azure-generated value and writes it
directly to that environment's Key Vault. Runtime configuration is
`AZURE_COMMUNICATION_CONNECTION_STRING`,
`AZURE_COMMUNICATION_EMAIL_SENDER`, and `ALERT_EMAIL_TO`.

## 6. Dev release and activation gate

Dev completed this sequence for release
`0b717c96d9a63dc58c1b9ac13ecdf1e3347898c7`. The first scheduled execution,
`caj-dev-agent-run-29779500`, succeeded at `2026-08-15T05:00:00Z`; the
post-run snapshot remained reconciled, position-free, lease-free, and at zero
trades.

The approved dev sequence is indivisible:

1. Deploy the exact CI-passed release in `disabled` mode with both jobs
   `Manual`.
2. Run and independently validate immutable `migrate-init`, `preflight`, and
   `target-smoke` evidence.
3. Stage `shadow` while both jobs remain `Manual`.
4. Capture a UTC boundary and unique `manual-shadow:` key, then start exactly
   one Manual hourly execution carrying that key.
5. Run activation-check afterward and require immutable proof that the exact
   new SHADOW `AgentRun` started after the boundary, reached a safe terminal
   outcome, created zero `TradeExecution`, and released the lease.
6. Capture the current schedule-activation timestamp; what-if, deploy, and
   validate `schedule-monitoring.bicep` with the fail-closed
   missing-hourly-success alert enabled; only then use `rollout.bicep` to
   switch both jobs to `Schedule` with the exact image digest and activation
   generation in the hourly idempotency namespace.
7. Observe a successful unmarked hourly execution from the first scheduled
   window; old same-hour executions from another image/generation cannot
   qualify.
8. Verify live mode, schedules, alert boundary, exact SHA, image digests, and
   observed execution.

Any failure or cancellation from shadow staging onward must automatically
restore `disabled`/`Manual`, verify both jobs are Manual with no schedule, then
disable and verify the missing-success boundary at `0`. The deployment remains
failed; successful rollback does not make a failed activation successful.

## 7. Prod release gate

Production release `ce7acc872f05899691ae44d4d826c9c8c94355c7` is deployed
**disabled/manual**. Migration, restore verification, and all 15 target-smoke
checks passed. No executable production promotion workflow is shipped or
approved.

Before any prod environment mutation:

- [x] Detect either a complete current release or a proven-fresh environment;
  partial state fails closed.
- [x] Verify the first environment was release-free; later final-image updates
  started from an already disabled/manual release and did not mutate the
  foundation.
- [x] Resolve and verify the live SHA, image digests, and config.
- [x] Create the fresh baseline restore-verified backup. Future replacement
  releases must run current-release preflight and backup and require its
  `JOB_EXECUTION_ID` to end `-current` so same-SHA current/new-release evidence
  paths cannot collide.
- [x] Only then apply environment mutation.
- [x] Deploy the new release disabled/manual and validate migration,
  baseline backup, target smoke, and immutable live state.

Prod deploy and rotation share the `azure-production-mutation` concurrency
lock and queue rather than cancel one another. The
`production-promotion` identity/environment has no activation workflow; any
future promotion requires a new evidence-bound design and review.

## 8. Mandatory provider and evidence gates

No provider is ready until retained live evidence proves all applicable rows:

| Gate | Required evidence | Current state |
|---|---|---|
| Azure resource providers | Owner registration completed; applicable deployment workflow `--check-only` checks passed | **Passed** |
| Foundry | Exact account/model/version/SKU/capacity and Entra plain + structured `HOLD` smokes | **Passed on operational fallback:** both deployments live; no model API key used |
| Quota | One exact catalog `usageName`, one exact quota dimension, and sufficient incremental capacity after subtracting only exact replaceable target deployments | **Passed** in the failed platform run |
| Coinbase | Authenticated provider smoke from the deployed target | **Passed in dev and prod target smoke** |
| ACS Email | Environment-specific sender; actual `sent` result and persisted delivery audit | **Passed in dev and prod** |
| PostHog | Mandatory environment tagging now; distinct projects before promotion | **Tagged ingestion passed; separate projects pending** |
| Database | Migration/init report, private target validation, app/owner role separation | **Passed in dev and prod** |
| Backup | Restore-verified backup bound to exact target SHA/digest | **Passed in dev proof and production baseline** |
| Admin/auth | Target-smoke proof without disclosing credentials | **Passed in dev and prod** |
| Scheduler | Unique manual-shadow proof, post-run activation report, digest/generation-namespaced scheduled success, and cross-mode replay rejection | **Passed in dev; production intentionally Manual** |
| Monitoring | Terminal job-failure alerts and activation-bound missing-hourly-success alert | **Passed; both Action Group tests dispatched successfully** |
| Rollback | Verified restoration to disabled/manual, followed by monitoring disablement, after an induced or actual failed dev activation | Pending |

Evidence must be bound to the exact release SHA and immutable web/ops image
digests. Job execution must use the full live template via `--yaml`, always
inject `JOB_EXECUTION_ID`, and accept only the three validated attended-proof
overrides: `SCHEDULED_IDEMPOTENCY_KEY`,
`EXPECTED_SHADOW_IDEMPOTENCY_KEY`, and
`EXPECTED_SHADOW_STARTED_AFTER`. A reconstructed approximation or arbitrary
environment override does not qualify. Immutable evidence storage and
independent download validation remain mandatory.

The execution helper must reject any template volume or container/init-container
volume mount because Azure `JobExecutionTemplate` cannot preserve them through
this override path. Current Project Krypto jobs use none.

## 9. Monitoring readiness

- [x] Azure Monitor terminal-failure alerts exist for scheduler jobs.
- [x] Schedule activation records the current UTC epoch and enables the
  fail-closed missing-hourly-success alert through
  `schedule-monitoring.bicep` before `rollout.bicep` switches to `Schedule`.
- [x] A successful hourly execution must be newer than that activation
  boundary; old executions cannot satisfy the alert.
- [x] Alert Action Group delivery is verified.
- [ ] PostHog events appear in the correct environment-specific project.
- [x] ACS guardrail/daily delivery evidence is persisted and queryable.
- [x] No schedule is considered healthy until an unmarked scheduled execution
  succeeds after activation.
- [ ] Disable, rollback, and rotation paths first verify both jobs are Manual
  with no schedule, then disable monitoring and reset its boundary to `0`.

See [`monitoring.md`](./monitoring.md) for signals and thresholds.

## 10. v2.2 paper-trading evidence gate

Azure deployment readiness proves infrastructure, not strategy readiness.
Paper promotion additionally requires:

- [ ] disabled and shadow evidence with no order mutation in either mode;
- [ ] an explicitly approved paper-mode transition;
- [ ] at least 30 consecutive days of complete scheduled paper evidence;
- [ ] zero guardrail breaches and zero duplicate overlapping runs;
- [ ] recorded turnover, fees, spread/slippage assumptions, drawdown, exposure,
  and benchmark-relative performance;
- [ ] complete decision, execution, email, analytics, and backup audit trails;
- [ ] reviewer sign-off on immutable evidence bound to the deployed release.

Imported, simulated, or historical reports are engineering-only and cannot
satisfy the production evidence window.

Passing these gates would support a future review; it does not activate
production. A new evidence-bound promotion design and executable workflow must
be reviewed and approved separately.

## 11. v3 live-money boundary

Live execution remains prohibited unless a future reviewed implementation and
explicit approval establish, at minimum:

- at least 60 consecutive days of qualifying paper evidence;
- a broker sandbox/certification pass;
- an independent execution adapter with idempotency controls;
- a tested kill switch and incident runbook;
- explicit human approval for every live rollout boundary; and
- a separate ADR and readiness sign-off.

Model output never directly mutates an execution venue. Deterministic
validation, guardrails, transaction semantics, and audit persistence remain
mandatory.

## 12. Exit criteria

Azure deployment exit criteria are met for dev shadow and production
disabled/manual. The public origins are recorded in
[`architecture.md`](./architecture.md). Paper promotion, a locked production
immutability policy, separate PostHog projects, and live-money execution remain
separate decisions and are not authorized.
