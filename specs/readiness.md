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
| Azure platform | **Operational agents ready** | Dev/prod toolless prompt agents version `1` passed exact structured `HOLD` smokes; the dedicated account remains model-empty |
| Azure dev | **Deployment-ready in shadow** | First scheduled run passed with zero trades; paper promotion still requires its separate evidence window |
| Azure prod | **Deployment-ready, disabled/manual** | Backup and target smoke passed; no promotion workflow is shipped |
| v2.2 paper rollout | **Not ready** | No 30-day qualifying paper evidence window, separate PostHog projects, or approved production promotion design |
| v3 live execution | **Not authorized** | Live execution is outside the current implementation and requires its own approval gates |

Source implementation, local tests, or a historical provider observation do
not satisfy a live Azure gate. The issue #132 source implementation has no live
Azure timing, capacity, readiness, quota, deadline-fence, or lease evidence yet.

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
| Foundry auth | Project Krypto mounts no model or agent API key; runtime and ops UAMIs receive only project-scoped **Project Krypto Foundry Agent Invoker** |
| Operational account local auth | Shared fallback still permits legacy local/model key auth; disable with the account owner or migrate before any production promotion |
| Deployment mutation scope | All mutation roles are resource-group-scoped; prod-deploy and platform Locks Contributor remain in their respective resource groups |
| Deployment subscription reads | One-action Project Krypto Provider Registration Reader on platform/dev/prod-deploy; Cognitive Services Usages Reader additionally on platform; no broad Reader |
| Runtime agent config | `AZURE_FOUNDRY_PROJECT_ENDPOINT`, `AZURE_FOUNDRY_AGENT_NAME`, immutable `AZURE_FOUNDRY_AGENT_VERSION`, `AZURE_CLIENT_ID` |
| Email | Separate dev/prod Azure Communication Services Email resources with Azure-managed domains |
| Analytics | Mandatory `deployment_environment` property now; distinct PostHog projects remain a production-promotion prerequisite |
| Execution envelope | Provider aggregate `125 s` (Coinbase `20`, version-pinned Foundry `80`, ACS `20`, PostHog `5`) < app `180 s` < scheduler HTTP `210 s` < ACA ingress platform bound `240 s` < job replica `270 s` < owned lease `300 s` |
| App deadline partition | Providers `125 s`; database policy/execution `20 s`; terminal persistence/owned-lease release `15 s`; cancellation/response `10 s`; slack `10 s` |
| Scheduler retries | Both scheduled jobs `replicaRetryLimit=0`; idempotency is defense in depth |
| Runtime capacity | Web max replicas `3`; pool max `1` and admitted runs `1` per replica; runtime login `CONNECTION LIMIT 20` |
| Runtime DB timeouts | Connect `5 s`; statement `10 s`; lock `2 s`; idle in transaction `15 s` |
| Readiness | Four-second, non-mutating and provider-free over runtime `DATABASE_URL` only; opaque reason codes |
| Daily provider ceilings | Coinbase `1,000`; version-pinned Foundry `200`; PostHog `2,000`; ACS `100` requests/UTC day; reconcile against contracted quotas and costs before rollout |
| RUN-01 ownership | Engineering: application/runtime; release/operator: plan/quota/cost reconciliation; operator: alert response |

`eastus2` was rejected because the selected subscription is restricted from
PostgreSQL provisioning there. It is a historical constraint, not a valid
deployment option.

## 3. Implemented workflow surfaces

Five Azure workflow surfaces implement or validate the target; Foundry Agent
project/agent deployment currently uses the documented authenticated local path:

| Workflow | Responsibility | Current live status |
|---|---|---|
| `azure-infra-validate.yml` | Source validation for Bicep, parameters, workflow contracts, and Azure helper tests | Validation-only; cannot produce live deployment evidence |
| `azure-platform.yml` | Dedicated Foundry account/model plan, apply, exact catalog/quota check, and no-trade smoke | Dedicated account/model attempt failed after account/catalog/quota; operational fallback models and smokes were completed separately |
| `azure-deploy-dev.yml` | Dev `foundation` or `full` release and monitored shadow activation | Live equivalent operator path completed; dev shadow/scheduled |
| `azure-deploy-prod.yml` | Prod `foundation` or `full` release ending disabled/manual | Live equivalent operator path completed; prod disabled/manual |
| `azure-rotate-secrets.yml` | Safe prod secret rotation with current-release disable/backup controls | Not run; production release exists and is currently disabled/manual |

### Source and CI runtime matrix

The release-candidate source contract is Node.js 22.13.0 and PostgreSQL 17:

| Surface | Contract |
|---|---|
| Node source/local | `.nvmrc` pins `22.13.0`; `package.json` permits `>=22.13.0 <23` |
| Container runtime | Both Docker targets use the exact Node.js 22.13.0 base |
| PostgreSQL source/local | Docker Compose, the real migration suite, the ops image clients/server, and Azure Flexible Server use major 17 |
| Pull-request CI | Quality and real-PostgreSQL jobs use `.nvmrc`; the database job runs `postgres:17` with PostgreSQL 17 client tools |
| Retained evidence | The database job writes `runtime-matrix.json` with the exact outputs of `node --version`, `npm --version`, `SHOW server_version`, `psql --version`, and `pg_dump --version`, plus the exact 40-hex commit SHA |

The generator rejects a Node patch mismatch, any PostgreSQL server/client major
other than 17, mismatched `psql`/`pg_dump` client releases, malformed output,
or a missing/malformed commit SHA. The immutable Actions artifact is named
`runtime-matrix-<commit-sha>`, cannot silently overwrite its JSON file, and is
uploaded with artifact replacement disabled for 90-day retention. A successful
artifact and integration job are
source/CI evidence only: they do not prove the target identity, extensions,
privileges, backup entitlement, or restore behavior owned by #74.

Issue #73 can close only after the matrix change merges, the exact merge SHA
passes the post-merge `main` checks, and those links are indexed in #76. The
future production-build browser harness in #153 must consume this same
`.nvmrc`/PostgreSQL 17 contract; this matrix work does not claim that the
separate harness already exists.

Platform account/model mutation uses separate environment-scoped what-if and
apply jobs. Agent project/access mutation used the equivalent local
what-if/apply path. GitHub Environments, branch restrictions, and protected
values are configured. Enterprise-hosted Actions are active, `CI_RUNNER_LABEL`
is unset, and the temporary Azure runner registrations/resource group are
retired. `platform`,
`production-deploy`, and `production-promotion` require `@VeVarunSharma` review
with `prevent_self_review=true` and administrator bypass disabled; `development`
intentionally has no reviewer.
Configured branch, exact-SHA, and CI gates remain mandatory. The authenticated
operator path used for the first release remains historical evidence, not the
current execution constraint.

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
  branch restrictions and protected values. Require `@VeVarunSharma` review
  with `prevent_self_review=true` and administrator bypass disabled on platform
  and both production boundaries;
  intentionally omit a development reviewer for routine dev delivery.
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
- [x] Retain both foundation handoffs and deploy isolated Foundry dev/prod
  projects; prove the project-scoped custom-only invoker for dev and preserve
  the reviewed equivalent for prod without mutating live prod.
- [x] Deploy and exactly attest toolless dev/prod prompt-agent version `1`;
  pass remote no-trade `HOLD` smoke for each.
- [x] Remove the four unused workload roles from the model-empty dedicated
  account; retain its platform smoke role and verified `CanNotDelete` lock.
- [ ] Release the agent-integrated app image, pass final post-provider no-trade
  database checks, then remove the four temporary account-scoped direct-model
  roles. Enterprise-hosted Actions are available; this remains gated on reviewed
  source, exact-SHA CI, and the environment-specific approval policy.
- [ ] Disable local/model key authentication on the shared operational account
  with its owner, or migrate the agents/models to the Entra-only dedicated
  account, before any production promotion design.

Both foundations are mandatory before agent access binding because the four
principal IDs are created by those foundations. A full release before access
binding is not an approved shortcut.

Any full dev run must use the exact CI-passed 40-hex SHA. GitHub evaluates
`workflow_run` with the workflow version on the default branch, so that
default-branch source must contain the reviewed trigger and gates. Development
has no reviewer by design; platform and production mutations require their
live environment approval.

## 5. Configuration readiness

### GitHub release secrets

Dev and prod require independent values for:

```text
POSTGRES_ADMIN_PASSWORD
DATABASE_URL
DIRECT_URL
MIGRATION_URL
CRON_SECRET
POSTHOG_API_KEY
ADMIN_PASSWORD
ADMIN_SESSION_SECRET
RUNTIME_DATABASE_PASSWORD
MIGRATOR_DATABASE_PASSWORD
DEPLOYMENT_APPROVAL_SECRET
```

Current state: runtime secret bindings passed both target smokes. The shared
PostHog key remains environment-tagged deployment evidence only.
`MIGRATION_URL` and `MIGRATOR_DATABASE_PASSWORD` are newly required by
[ADR 0014](./decisions/0014-postgresql-trust-boundary-roles.md); source
support is implemented but neither environment's live secrets have been set
to these values, and no live role migration has run (see `deployment.md` §13).

- Coinbase pagination, complete UTC four-hour candle construction, freshness,
  gap, timeout, retry, and flat-RSI behavior are covered by focused tests.
- Drizzle is the only application migration history. Fresh install,
  existing-v2 adoption, row preservation, and idempotent singleton
  initialization pass against temporary real PostgreSQL clusters.
- Application tables and the enum move into the private `krypto` schema.
  `PUBLIC`/anonymous/authenticated table, column, schema, sequence, Krypto
  routine, and Vault schema/relation/routine privileges are denied in real
  migration tests and inventoried across every protected relation by preflight.
  Protected public views and every executable public `SECURITY DEFINER`
  routine are also blocked. The migration removes the unsafe legacy
  arbitrary-path helper. Cron scheduling is a separate
  transactional reviewed operation that rejects canonical-function drift and
  verifies the latest passing smoke approval against decrypted Vault URL/secret
  values, rejects unexpected jobs or queued endpoint requests, and verifies
  both final job definitions before commit. Every cron request carries its
  Vault-selected shadow/paper mode, so delayed requests fail across promotion
  boundaries.
- Unused AgentKit/OpenAI packages and CDP requirements are removed. A same-major
  PostCSS override removes Next.js's vulnerable nested copy; `npm audit
  --omit=dev` reports zero production vulnerabilities.
- Foundry uses explicit Anthropic endpoint configuration with a no-trade smoke
  command and temporary legacy environment compatibility.
- The mutating ReAct trade tool has been removed. One structured model proposal
  is evaluated by deterministic policy, while mandatory stop-loss exits bypass
  model discretion. Mandatory exits still require fresh validated market data,
  a `RECONCILED` account, and `paper` mode; shadow records but does not execute
  them.
- New paper execution is fixed-point/numeric, locked-row transactional,
  idempotent by `AgentRun`, weighted-cost-basis aware, and reconciled to the
  immutable trade ledger.
- Backtests now reuse production policy and the pure execution calculation used
  by the transactional executor; post-action equity drives same-step drawdown.
  Sharpe, Sortino, Calmar, turnover, fee efficiency, win rate, profit factor,
  benchmark alpha, modeled slippage, optional LLM-cost-adjusted PnL, and version
  metadata are reported with unavailable ratios represented as `null`.
- Run orchestration now persists `AgentRun` outcomes, uses owned expiring
  leases, supports disabled/shadow/paper modes, bounds model calls to two
  attempts with 20-second attempt timeouts, records attempt count/latency, and
  flushes PostHog per request.
- Real PostgreSQL tests prove disabled mode, idempotent replay, cold start,
  mandatory stop-loss without a model, shadow non-execution, active-lease
  conflict, expired-lease recovery, configuration errors, market failures,
  transaction rollback, concurrency, and owner mismatch rejection.
- Operator pause/resume, expired-lease recovery, and drawdown-lock override now
  write atomic audit journal entries. Unlock requires an explicit reason and is
  refused while an owned run lease is active.
- Next.js startup instrumentation validates required runtime configuration, and
  mutating admin handlers re-verify the signed session in addition to proxy
  enforcement.
- The admin dashboard derives missed-run, lease, market-freshness,
  reconciliation, and alert-delivery health from persisted state. Daily-summary
  sent/skipped/failed outcomes are persisted and route/database failures are
  explicit.
- CI now enforces lint, app and script/test typechecking, production build,
  critical-module coverage, all engineering backtests, production dependency
  audit, real-PostgreSQL migration/executor/orchestration tests, and migration
  drift. A protected manual no-trade Foundry smoke workflow is included.
- Harness integrity now enforces canonical agentic policy, instruction/reference
  integrity, deterministic SDLC safety fixtures, report-only entropy contracts,
  and byte-stable GH-AW source/lock generation. A mock-first per-worktree app
  harness proves isolated database/app startup and operator-console safety states
  without production credentials or provider calls.
- The evidence-pipeline foundation imports strict versioned CSV/JSON datasets,
  binds dataset and plan provenance, evaluates isolated predeclared windows
  through the production-aligned runner, suppresses invalid gap-spanning risk
  metrics, and emits deterministic JSON plus dark standalone HTML reports.
  Imported reports are always classified `engineering-only` and cannot satisfy
  v2.2 or v3 production evidence gates.
- The cron rollout-mode NULL fix is an additive migration after the original
  immutable `0005` history. Real-PostgreSQL tests prove an existing database at
  `0005` receives the corrected functions through normal Drizzle migration.
- Current local validation: lint passes with one pre-existing PostCSS config
  warning; the coverage-gated Jest suite, script/test typecheck, production
  build, and real-PostgreSQL suite pass;
  deliberate cron-function tampering and `PUBLIC` table exposure are rejected;
  migration generation reports no drift; and the production dependency audit
  is clean. The 8-scenario aggregate reports 8 engineering assertion passes,
  3/8 beating cash, 2/8 beating buy-and-hold, and 0/8 beating both.
Readiness requirements:

- [x] `DATABASE_URL` uses the least-privilege `krypto_app` role.
- [x] `DIRECT_URL` uses `krypto_owner`; both database URLs target the same
  private PostgreSQL 17 database with `sslmode=require`.
- [ ] `MIGRATION_URL` uses the dedicated least-privilege `krypto_migrator`
  role over a direct connection distinct from `DIRECT_URL` and `DATABASE_URL`,
  set as a live GitHub Environment secret in dev and prod, and used to run
  the attended upgrade in `deployment.md` §13 — source implemented, not yet
  run live.
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
| Database | Migration/init report, private target validation, app/owner role separation | **Passed in dev and prod** for the deployed `krypto_app`/`krypto_owner` split. The extended `krypto_schema_owner`/`krypto_migrator`/`krypto_scheduler` trust boundary and dedicated `MIGRATION_URL` ([ADR 0014](./decisions/0014-postgresql-trust-boundary-roles.md), issue [#133](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/133)) are source-implemented; the attended per-environment upgrade (§13 of `deployment.md`) has not been run — **pending** |
| Backup | Restore-verified backup bound to exact target SHA/digest | **Passed in dev proof and production baseline** |
| Admin/auth | Target-smoke proof without disclosing credentials | **Passed in dev and prod** |
| Scheduler | Unique manual-shadow proof, post-run activation report, digest/generation-namespaced scheduled success, and cross-mode replay rejection | **Passed in dev; production intentionally Manual** |
| RUN-01 bounded execution | Source tests for deadline/provider/readiness/capacity behavior; future exact-release target proof remains required | **Source implemented; no live issue #132 evidence** |
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

### DB-01 evidence contract (issue #133 / ADR 0014)

Completing the Database gate's extended trust-boundary row requires indexing,
per environment, in issue
[#76](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/issues/76):
a redacted role matrix (`krypto_owner`/`krypto_schema_owner`/`krypto_migrator`/
`krypto_scheduler`/`krypto_runtime`/`krypto_app` — attributes, connection
limits, memberships, `SET`/`INHERIT` boundary, no secrets); a GitHub
Environment secret inventory proving `MIGRATION_URL`/
`MIGRATOR_DATABASE_PASSWORD` are absent from the web/scheduler runtime and
from `verified-backup`/`target-smoke`/`activation-check`; the `migrate-init`
migration attestation for that environment's own upgrade run; the
`trust-boundary-runtime-denial-matrix` denial transcript; and the
`scripts/test-migrations.sh` fresh-install and upgrade test transcript. None
of this evidence exists yet for a live environment — see `deployment.md` §13.

### RUN-01 evidence contract (issue #132 / ADR 0015)

The source contract is [ADR 0015](./decisions/0015-bounded-synchronous-execution.md). Source/CI can prove constants, migration behavior, deterministic fault tests, Bicep values, and readiness response shape. It cannot prove ACA platform duration, deployed replica settings, private PostgreSQL capacity/identity, live provider plans, target latency, or target fault behavior.

**Source/CI evidence to index in #76:** frozen source ref and merge SHA; protected-main checks and source-governance policy version; Node/npm/PostgreSQL 17 matrix; migration `0009` inventory/hash/drift result; deadline ordering and partition tests; scheduler one-attempt/zero-retry values; database timeout/pool/admission configuration; PAPER commit-fence, delay/retry/`Retry-After`/cancellation/terminal/lease/provider-budget fault tests; readiness/liveness tests; and clear engineering-only classification.

**Future exact-release target evidence to index in #76:** immutable deployment identity, release SHA/image digest/config digest; `westus3` ACA and private PostgreSQL 17 identity; live max-replica/job-retry/job-timeout settings; runtime `krypto_app` role/membership/denial/`CONNECTION LIMIT 20` and database timeouts; bounded readiness success and reason-code failure probes; pool/outage/failover/lock-contention/admission behavior; provider plan/rate-limit/quota/cost reconciliation and daily-ceiling exhaustion; one terminal persisted no-trade run; owned lease release or safe expiry; no PAPER commit at/after deadline; alerts and operator response. None of this future #132 target evidence is claimed to exist.

#### Exact canonical issue #76 requirements

The following release-evidence matrix remains mandatory:

- Frozen source ref, merge SHA, protected-main checks, and source-governance policy version.
- Explicit distinction between AI/check authorization, human source approval, target-mutation approval, shadow approval, and PAPER approval.
- Node/npm/PostgreSQL server/client version proof.
- Migration inventory, hashes, drift result, database role/ownership matrix, and runtime/migrator separation.
- Target identity, immutable deployment ID, configuration digest, readiness result, and preflight.
- Provider/application backup checksums, RPO/RTO restore proof, and retention policy.
- Admin and cron authentication control evidence.
- Exact-deployment disabled smoke and 30-minute observation.
- Shadow completeness, zero-trade proof, expected daily summaries, alerts, classified gaps, and rollback rehearsal.
- PAPER promotion approvals, first-run reconciliation, 24-hour attended coverage, and stop-drill evidence.
- Predeclared 30-day continuity and exact-window evaluation report.
- Clear classification of engineering fixtures versus historical, target, and financial evidence.

The canonical index must also satisfy these acceptance criteria:

- One canonical issue/comment thread indexes every gate and artifact for the frozen release candidate.
- Every artifact is immutable or checksum-addressed and bound to the exact artifact, deployment, target, migration, configuration, actor, and timestamp it proves.
- Approval records include role, intended mutation, evidence digest, expiry, and rollback owner; bot/self/stale approvals are marked invalid.
- Redaction rules exclude secrets while retaining independently verifiable metadata.
- Missing, stale, expired, or contradictory evidence is explicitly blocking.
- Synthetic/engineering evidence is never presented as production-performance evidence.
- Gate checkpoints can be marked complete without closing this long-lived index.
- Final closure occurs only after #127 (CTRL-11)'s attended PAPER and 30-day evidence gate completes and humans record the final go/no-go decision and unresolved risks.

P0: no target mutation or rollout approval may rely on narrative, screenshots, mutable comments, or this issue's existence alone. Each protected action requires its own evidence-bound authorization.

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
