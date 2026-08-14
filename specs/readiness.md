# Deployment and trading readiness

> **State snapshot: 2026-08-14 — NOT PROVISIONED.** Project Krypto's Azure
> target is implemented in source but no Project Krypto Azure resource,
> application URL, retained what-if/apply artifact, ops-job report, provider
> smoke, backup, alert, or scheduled-run evidence exists. Every live gate in
> this document is pending.
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
| Azure platform | **Not ready** | Dedicated platform has not been provisioned or smoke-tested |
| Azure dev | **Not ready** | Foundation, access binding, release, evidence, and monitored schedule activation have not run |
| Azure prod | **Not ready** | Foundation/access and disabled/manual release evidence have not run |
| v2.2 paper rollout | **Not ready** | No observed scheduled Azure execution, qualifying paper evidence window, or approved production promotion design |
| v3 live execution | **Not authorized** | Live execution is outside the current implementation and requires its own approval gates |

Source implementation, local tests, or a historical provider observation do
not satisfy a live Azure gate.

## 2. Approved target contract

| Control | Required value |
|---|---|
| Runtime-selected subscription | **Visual Studio Enterprise Subscription**; never publish its ID/internal identifiers |
| Region | `westus3` |
| Resource groups | `rg-krypto-platform`, `rg-krypto-dev`, `rg-krypto-prod` |
| Foundry account | Bicep-managed `ai-krypto-westus3` |
| Model | OpenAI `gpt-5.6-luna` version `2026-07-09` |
| Deployment SKU/capacity | `GlobalStandard`; desired dev 10 + prod 10, with deployment-pair-aware incremental validation against the exact quota dimension |
| Deployment names | `krypto-dev-luna`, `krypto-prod-luna` |
| Foundry auth | Local auth/API keys disabled; runtime and ops UAMIs receive only **Cognitive Services OpenAI User** |
| Deployment mutation scope | All mutation roles are resource-group-scoped; prod-deploy and platform Locks Contributor remain in their respective resource groups |
| Deployment subscription reads | One-action Project Krypto Provider Registration Reader on platform/dev/prod-deploy; Cognitive Services Usages Reader additionally on platform; no broad Reader |
| Runtime model config | `AZURE_OPENAI_BASE_URL` ending `/openai/v1`, `AZURE_OPENAI_DEPLOYMENT_NAME`, `AZURE_CLIENT_ID` |
| Email | Separate dev/prod Azure Communication Services Email resources with Azure-managed domains |
| Analytics | Separate PostHog project keys for dev and prod |

`eastus2` was rejected because the selected subscription is restricted from
PostgreSQL provisioning there. It is a historical constraint, not a valid
deployment option.

## 3. Implemented workflow surfaces

Six Azure workflow surfaces implement or validate the target:

| Workflow | Responsibility | Current live status |
|---|---|---|
| `azure-infra-validate.yml` | Source validation for Bicep, parameters, workflow contracts, and Azure helper tests | Validation-only; cannot produce live deployment evidence |
| `azure-platform.yml` | Dedicated Foundry account/model plan, apply, exact catalog/quota check, and no-trade smoke | Not run |
| `azure-platform-access.yml` | Separate plan/apply for four runtime/ops account-role bindings | Not run |
| `azure-deploy-dev.yml` | Dev `foundation` or `full` release and monitored shadow activation | Not run |
| `azure-deploy-prod.yml` | Prod `foundation` or `full` release ending disabled/manual | Not run |
| `azure-rotate-secrets.yml` | Safe prod secret rotation with current-release disable/backup controls | Not run |

Platform account/model mutation and platform access each use separate
protected what-if and apply jobs. Dev/prod deploy workflows support
`foundation` and `full`; automatic `workflow_run` events select `full`.

No executable production promotion workflow is shipped or approved.
`production-promotion` remains only as the protected forced-disable
identity/environment used within prod deploy and rotation. Any future
production promotion requires a new evidence-bound design and review.

## 4. Mandatory provisioning order

- [ ] Select **Visual Studio Enterprise Subscription** at runtime by display
  name; retain no subscription ID in public documentation.
- [ ] As an authorized subscription owner, run
  `.github/scripts/azure/register-providers.sh` and wait for every required
  namespace, including `Microsoft.Network`, to reach `Registered`. Deployment
  workflows use `--check-only` and cannot perform this subscription mutation.
- [ ] Review and apply `bootstrap.bicep` in `westus3`.
- [ ] Verify the custom provider-state role contains only
  `Microsoft.Resources/subscriptions/providers/read` and is assigned only to
  platform/dev/prod-deploy; verify platform additionally has Cognitive Services
  Usages Reader.
- [ ] Verify Locks Contributor is scoped to `rg-krypto-platform` for the
  Foundry lock and `rg-krypto-prod` for the prod PostgreSQL, Key Vault, and
  evidence-storage locks.
- [ ] Configure protected `platform`, `development`, and `production-deploy`
  GitHub Environments, plus the forced-disable-only `production-promotion`
  Environment, with required reviewers.
- [ ] Run the protected Foundry account what-if/apply.
- [ ] Prove the exact model catalog match and quota availability for the two
  target deployment-name/capacity pairs. Subtract only exact existing target
  capacity on the same format/model/version/SKU dimension, then run the
  protected model what-if/apply.
- [ ] Pass the Entra-authenticated plain-response and structured `HOLD`
  no-trade platform smokes.
- [ ] Deploy the dev foundation.
- [ ] Deploy the prod foundation.
- [ ] Retain both foundation handoffs and bind the exact dev/prod runtime and
  ops principal IDs through `azure-platform-access.yml`.
- [ ] Verify exactly one Cognitive Services OpenAI User assignment per
  workload principal before any full release.

Both foundations are mandatory before the access workflow because the four
principal IDs are created by those foundations. A full release before access
binding is not an approved shortcut.

The first dev run must be a manual dispatch at the exact CI-passed 40-hex SHA.
GitHub evaluates `workflow_run` with the workflow version on the default
branch; automatic dev pushes become eligible only after that updated workflow
has reached `main`.

## 5. Protected configuration readiness

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

Readiness requirements:

- [ ] `DATABASE_URL` uses the least-privilege `krypto_app` role.
- [ ] `DIRECT_URL` uses `krypto_owner`; both database URLs target the same
  private PostgreSQL 17 database with `sslmode=require`.
- [ ] `DEPLOYMENT_APPROVAL_SECRET` differs from `CRON_SECRET`.
- [ ] Dev and prod `POSTHOG_API_KEY` values identify separate projects.
- [ ] No long-lived Azure credential or Foundry API key is stored in GitHub.

ACS connection strings are not GitHub secrets or workflow inputs.
`release.bicep` obtains each environment's Azure-generated value and writes it
directly to that environment's Key Vault. Runtime configuration is
`AZURE_COMMUNICATION_CONNECTION_STRING`,
`AZURE_COMMUNICATION_EMAIL_SENDER`, and `ALERT_EMAIL_TO`.

## 6. Dev release and activation gate

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

Initial production provisioning ends with the new release
**disabled/manual**. No executable production promotion workflow is shipped or
approved.

Before any prod environment mutation:

- [ ] Detect either a complete current release or a proven-fresh environment;
  partial state fails closed.
- [ ] Force-disable a complete current release under the protected
  forced-disable identity, verify both jobs are Manual, then disable and verify
  schedule monitoring.
- [ ] Resolve and verify its live SHA, image digests, and config.
- [ ] Run current-release preflight and restore-verified backup; require its
  `JOB_EXECUTION_ID` to end `-current` so same-SHA current/new-release evidence
  paths cannot collide.
- [ ] Only then apply environment mutation.
- [ ] Deploy the new release disabled/manual and validate migration,
  baseline backup, target smoke, and immutable live state.

Prod deploy and rotation share the `azure-production-mutation` concurrency
lock and queue rather than cancel one another. The
`production-promotion` identity/environment has no activation workflow; any
future promotion requires a new evidence-bound design and review.

## 8. Mandatory provider and evidence gates

No provider is ready until retained live evidence proves all applicable rows:

| Gate | Required evidence | Current state |
|---|---|---|
| Azure resource providers | Owner registration completed; applicable protected deployment workflow `--check-only` checks passed | Pending |
| Foundry | Exact account/model/version/SKU/capacity, local auth disabled, Entra plain + structured `HOLD` smokes | Pending |
| Quota | One exact catalog `usageName`, one exact quota dimension, and sufficient incremental capacity after subtracting only exact replaceable target deployments | Pending |
| Coinbase | Authenticated provider smoke from the deployed target | Pending |
| ACS Email | Environment-specific sender; actual `sent` result and persisted delivery audit | Pending |
| PostHog | Distinct dev/prod keys and environment-specific ingestion proof | Pending |
| Database | Migration/init report, private target validation, app/owner role separation | Pending |
| Backup | Restore-verified backup bound to exact target SHA/digest | Pending |
| Admin/auth | Target-smoke proof without disclosing credentials | Pending |
| Scheduler | Unique manual-shadow proof, post-run activation report, digest/generation-namespaced scheduled success, and cross-mode replay rejection | Pending |
| Monitoring | Terminal job-failure alerts and activation-bound missing-hourly-success alert | Pending |
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

- [ ] Azure Monitor terminal-failure alerts exist for scheduler jobs.
- [ ] Schedule activation records the current UTC epoch and enables the
  fail-closed missing-hourly-success alert through
  `schedule-monitoring.bicep` before `rollout.bicep` switches to `Schedule`.
- [ ] A successful hourly execution must be newer than that activation
  boundary; old executions cannot satisfy the alert.
- [ ] Alert Action Group delivery is verified.
- [ ] PostHog events appear in the correct environment-specific project.
- [ ] ACS guardrail/daily delivery evidence is persisted and queryable.
- [ ] No schedule is considered healthy until an unmarked scheduled execution
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

Update this document from **NOT PROVISIONED** only after the matching protected
workflow completes and retained evidence has been reviewed. Add Azure URLs to
the live endpoint register in [`architecture.md`](./architecture.md) only
after deployment and target-smoke success. Until then:

- Azure platform/dev/prod status remains **Not provisioned**;
- there is no approved Azure URL;
- there is no live Azure smoke, backup, alert, or schedule evidence; and
- neither paper promotion nor live-money execution is authorized.
