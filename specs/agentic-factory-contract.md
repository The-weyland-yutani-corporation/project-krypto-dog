# Agentic factory contract

This is the normative, machine-oriented contract for the safety-bounded
autonomous SDLC factory approved in
[ADR 0013](./decisions/0013-autonomous-agentic-sdlc-factory.md). It defines
every field, label, transition, and boundary that governs whether a piece of
work may be autonomously claimed, implemented, merged, and deployed to dev --
and exactly where autonomy stops.

This document is authoritative over informal descriptions elsewhere. Where it
and `docs/agentic-software-factory.md` or `.github/BACKLOG_GOVERNANCE.md`
appear to disagree, this contract's risk/lifecycle/checks/exclusion rules
govern the factory's autonomy boundary; `BACKLOG_GOVERNANCE.md` remains
authoritative for milestone/WIP policy, and `docs/agentic-software-factory.md`
remains the narrative/operational overview.

Fields, constants, and function names below that already exist in
`.github/scripts/agentic-factory-policy.cjs` and
`.github/scripts/agentic-queue-controller.cjs` are cited by their exact
identifiers. Anything not yet implemented is written as a requirement
("MUST"/"MUST NOT") for the workflow(s) that implement it.

## 1. Actors

| Actor | Role |
|---|---|
| `human-operator` | The only actor who may approve goals, approve boundary-tier changes, unpause the factory, and perform production/live actions. |
| `product-manager` | Triages opportunities, promotes issues toward planning. |
| `engineering-manager` | Decomposes approved work into sequenced, ready-for-ai-dev tickets. |
| `rubber-duck` | Challenges approach/risk before implementation. |
| `queue-controller` | The deterministic module (`agentic-queue-controller.cjs`) that selects at most one eligible issue. |
| `assignment-worker` | The workflow step that turns a queue-controller selection into a claimed, dispatched implementation session. |
| `implementation-agent` | Copilot coding-agent session that opens a PR for a claimed issue. |
| `lifecycle-reconciler` | The workflow that reconciles PR/check state into lifecycle-label transitions (opens/closes duplicate PRs, applies repair/blocked/human-review labels). |
| `merge-policy` | The deterministic `Agentic merge policy` check that approves same-repository PRs after current-head required checks pass. |
| `deployment-reconciler` | The workflow that validates dev evidence and applies `factory:deployed-dev`. |

## 2. Factory modes

The factory has exactly three modes, carried by one open issue labeled
`factory-control`. That issue MUST carry exactly one of
`factory-mode:shadow`, `factory-mode:active`, or `factory-mode:paused`; the
queue adapter maps the suffix to `config.factoryMode`:

| Mode | Queue controller behavior | Merge/deploy behavior |
|---|---|---|
| `shadow` | Runs `selectNextIssue`; result is `advisory: true`. Nothing is claimed or dispatched. | Merge policy and deployment reconciler compute results but do not act. |
| `active` | Dispatches the selected candidate (if any) for real. | Merge policy and deployment reconciler act within the bounds of this contract. |
| `paused` | No selection is attempted. | No merge or deploy action is attempted. Existing in-flight work is left exactly as-is (no forced cancellation). |

Any other value, or a missing value, MUST be treated as `paused` (fail
closed) -- this matches `evaluateEligibility`'s existing behavior of
rejecting every candidate with `factory-not-active` when `factoryMode` is not
`"active"` or `"shadow"`.

**Mode transition rule:** automation MAY transition `active -> paused` or
`active -> shadow` unilaterally (see §15, pause triggers). Automation MUST
NOT transition `paused -> active` under any condition, including elapsed
time, retried workflow runs, or repeated evaluation of the same trigger as
no-longer-present. Only a `human-operator` action (recorded as an atomic mode-label transition on
the control issue) may resume `active`.

## 3. Goal authorization

A **goal** is a tracked issue created from the "Autonomous factory goal"
issue template (`.github/ISSUE_TEMPLATE/factory-goal.yml`), carrying the
`factory:goal` classification label. Every work item's `parentGoalNumber`
MUST resolve to exactly one open goal issue via GitHub's native
sub-issue/tracking relationship, and every discovery/planning/triage
workflow MUST require that ancestor before creating or advancing work
(mirrored today in `pm-triage`, `opportunity-discovery`, and `em-planning`).

**Approval is a label, not a body field.** A goal authorizes nothing until a
`human-operator` applies `factory:goal-approved` to it. `factory:goal`
present without `factory:goal-approved` (or with `factory:goal-approved`
later removed by a human) means `config.goalApproved` / a candidate's
`parentGoalApproved` MUST resolve to `false`, and every descendant fails
eligibility with `goal-not-approved`. Only a `human-operator` may add or
remove `factory:goal-approved`; automation MUST NOT self-apply it.

The goal issue template's structured fields are the human-facing source for
the machine fields the queue controller consumes
(`QueueControllerConfig` in `agentic-queue-controller.cjs`). An
assignment-worker/adapter reading a goal issue MUST resolve them as follows,
failing closed to the listed default whenever a field is blank, unparsable,
or the issue lacks `factory:goal-approved`:

| Template field | Maps to | Fail-closed default if missing/malformed |
|---|---|---|
| `factory:goal-approved` label present | `config.goalApproved` and per-candidate `parentGoalApproved` | `false` |
| Goal milestone | `config.allowedMilestones` -- the active goal MUST have a milestone and its title is the initial allow-list entry | empty list (nothing matches) |
| Allowed scope | Additional path/subsystem boundary checked by PM/EM and assignment validation; it never widens the goal milestone or risk ceiling | empty scope (nothing matches) |
| Allowed paths | `config.goalAllowedPaths`; exact repo-relative files or terminal `path/**` globs that child issue patterns must remain within | empty list (nothing matches) |
| Maximum autonomous risk tier (`max_risk`, dropdown: `risk:routine`/`risk:sensitive`/`risk:boundary`) | `config.maxGoalRiskTier` via `resolveMaxGoalRiskTier` | `risk:routine` (the most restrictive non-boundary value the function resolves an unknown input to) |
| Maximum active coding-agent sessions (`max_wip`, default `"1"`) | `config.concurrencyLimit` | `0` (blocks all dispatch) |
| Assignment budget (`assignment_budget`) | `config.dailyBudgetLimit` (consumed against `config.currentBudgetUsed`); the field only changes by a human editing the issue -- "renewal" in the template's own wording -- never by automation | `0` (blocks all dispatch) |
| Required evidence | operationalized by §12 (evidence gate) and §13 (dev evidence contract) | treated as unspecified -- no evidence gate may be considered cleared |
| Pause and stop conditions | goal-specific additions to the baseline pause triggers in §15 | none (only the §15 baseline triggers apply) |
| Human-only boundaries checkboxes (production deployment, live-trading enablement, "may pause but not unpause") | restates §14 and §2/§15; MUST all be checked for a goal to be approved | goal is treated as unapproved if any is unchecked |

An unparsable or missing field authorizes **nothing** for that dimension:
every candidate under an under-specified goal fails eligibility for the
corresponding reason (`goal-not-approved`, `milestone-not-allowed`,
`risk-exceeds-goal-max`, `concurrency-limit-reached`, or
`budget-limit-reached`) rather than falling back to an implicit "allow."

The factory's overall mode (`shadow`/`active`/`paused`, §2) comes from the
singleton control issue, not a goal field. No goal's authorization has any
effect while the factory mode is not `active` or `shadow`.

## 4. Work-item readiness fields

Every issue candidate presented to `selectNextIssue` MUST carry (or the
adapter that builds the candidate MUST fail closed to `false`/`null` for) the
following fields, matching `QueueCandidate` in `agentic-queue-controller.cjs`:

| Field | Meaning | Missing/unknown behavior |
|---|---|---|
| `hasAcceptanceCriteria` | Issue states a checkable "done" condition. | Not `true` -> `readiness-incomplete:hasAcceptanceCriteria` |
| `hasValidationPlan` | Issue states how the change will be verified (tests, manual check). | Not `true` -> `readiness-incomplete:hasValidationPlan` |
| `hasScopeDefinition` | Issue states what is and is not in scope. | Not `true` -> `readiness-incomplete:hasScopeDefinition` |
| `hasRiskAssessment` | Issue states the risk tier and reasoning (see §6). | Not `true` -> `readiness-incomplete:hasRiskAssessment` |
| `hasRollbackPlan` | Issue states how the change is reverted if wrong. | Not `true` -> `readiness-incomplete:hasRollbackPlan` |
| `parentGoalNumber` / `parentGoalApproved` | Links to and reflects §3. | Missing/false -> `missing-parent-goal` / `goal-not-approved` |
| `dependencyStates` | State of every blocking dependency issue. | Missing/unknown -> `dependencies-unknown`; any not `"closed"` -> `dependencies-not-closed` |
| `milestone` | GitHub milestone title. | Not on `allowed_milestones` -> `milestone-not-allowed` |
| `isLeaf` | No open child/tracking (sub-)issues. | Not `true`, or issue not `open` -> `not-open-leaf` |
| `priority` | Optional `P0`/`P1`/`P2` label-derived value. | Unknown/absent ranks after `P0`/`P1` (§13 ordering), never rejected |
| `assignees` / `hasOpenSession` / `hasOpenPullRequest` | Concurrency/idempotency guards. | Any true/non-empty -> `already-assigned` / `already-has-open-session` / `already-has-open-pull-request` |
| `activeClaim` | Current claim lease, if any (§9). | Active -> `active-claim`; stale -> `stale-claim-requires-recovery` |
| `createdAt` | ISO-8601 creation timestamp, used for tie-break ordering. | Invalid -> `invalid-created-at` |

All five readiness fields, `hasAcceptanceCriteria` through `hasRollbackPlan`,
are independently required: an issue missing any one of them is ineligible
regardless of how many others it satisfies.

`hasScopeDefinition` additionally requires a valid `Allowed paths` issue-form
section. Each line is either one exact repo-relative file or one terminal
directory glob (`path/**`). Absolute paths, parent traversal, backslashes, and
other wildcard forms are invalid. Before PR enrollment, every current and
previous filename in the PR diff MUST match one of these patterns; any escape
blocks the issue and pauses the factory.
Every child pattern MUST also be contained by the active goal's `Allowed paths`;
a child cannot widen its human-approved parent scope.

## 5. Lifecycle labels

These are the exact, durable lifecycle-state labels. An issue or PR carries
**exactly one** of these at a time (never zero once past `needs-triage`,
never more than one).

| Label | Meaning | Set by |
|---|---|---|
| `needs-triage` | PM should refine the issue. | `product-manager` |
| `ready-for-planning` | EM should decompose work. | `product-manager` / `rubber-duck` |
| `ready-for-ai-dev` | Eligible for queue-controller selection once readiness (§4) and goal authorization (§3) hold. | `engineering-manager` / `rubber-duck` |
| `factory:claimed` | `queue-controller` has selected this issue and issued a claim (§9); an `assignment-worker` has not yet started the session. | `queue-controller` |
| `factory:implementing` | An `implementation-agent` session is open against the claim. | `assignment-worker` |
| `factory:pr-open` | The implementation agent's PR is open and under required checks. | `lifecycle-reconciler` |
| `factory:repairing` | A capped self-heal attempt (§11) is in progress on the open PR. | `lifecycle-reconciler` |
| `ready-for-human-review` | A human-boundary gate: boundary-tier work, an exhausted repair budget, or an explicit reconciler failure. | `lifecycle-reconciler` / `human-operator` |
| `blocked` | Hard stop; only `human-operator` may resume out of it. | any actor (fail-closed) / `human-operator` |
| `factory:merged` | PR merged by `merge-policy` or by `human-operator` approval on a boundary-tier PR. | `merge-policy` / `human-operator` |
| `factory:deployed-dev` | Dev evidence (§13) validated for the exact merged SHA. | `deployment-reconciler` |
| `factory:done` | Terminal: no further factory action occurs. | `lifecycle-reconciler` |

### Legal transitions

| From | To | Owner |
|---|---|---|
| `ready-for-ai-dev` | `factory:claimed` | `queue-controller` |
| `factory:claimed` | `ready-for-ai-dev` | `queue-controller` (claim released/expired and explicitly recovered, §9) |
| `factory:claimed` | `factory:implementing` | `assignment-worker` |
| `factory:implementing` | `factory:pr-open` | `lifecycle-reconciler` |
| `factory:pr-open` | `factory:repairing` | `lifecycle-reconciler` (a required check failed and the repair cap, §11, is not exhausted) |
| `factory:repairing` | `factory:pr-open` | `lifecycle-reconciler` (repair attempt pushed; checks re-run) |
| `factory:pr-open` | `ready-for-human-review` | `lifecycle-reconciler` (boundary tier, or repair cap exhausted) |
| `factory:pr-open` | `factory:merged` | `merge-policy` |
| `ready-for-human-review` | `factory:merged` | `human-operator` |
| `ready-for-human-review` | `blocked` | `human-operator` |
| `factory:merged` | `factory:deployed-dev` | `deployment-reconciler` |
| `factory:deployed-dev` | `factory:done` | `lifecycle-reconciler` |
| `*` (any known state) | `blocked` | `lifecycle-reconciler` (fail-closed); a human may also apply the hard-stop label directly |
| `blocked` | `ready-for-planning` | `human-operator` |
| `blocked` | `ready-for-ai-dev` | `human-operator` |

Any transition not in this table is illegal. A workflow attempting an illegal
transition, or a transition performed by an actor other than the listed
owner, MUST fail closed to `blocked` rather than silently applying the
requested label.

## 6. Risk labels

Every work item (issue and its resulting PR) carries **exactly one** risk
label:

| Label | Meaning |
|---|---|
| `risk:routine` | Reversible, low-blast-radius change (UI, docs without sensitive keywords, tests, scenarios). |
| `risk:sensitive` | Reversible but reviewable change (trading/guardrail/agent/db/deployment code, dependency/infra manifests, most of `specs/`). |
| `risk:boundary` | Irreversible or control-plane/human-boundary scope (workflows, factory scripts/agents/skills, CODEOWNERS, branch-protection/repo-policy docs, live-trading/production-promotion RFC scope, secrets/permissions/identity policy, destructive migrations). |

### Path-risk floor

The risk tier is computed by `determineRiskTier` in
`agentic-factory-policy.cjs` as **the more conservative of** the path-derived
tier (`classifyPathTier` over every changed file, maxed via `maxRiskTier`)
and any issue-declared `issueRiskLabel`. An issue-declared risk label MAY
only raise the tier above the path floor; it MUST NOT lower it. A destructive
migration statement detected in any changed file (`DROP TABLE`, `DROP
COLUMN`, `DROP SCHEMA`, `TRUNCATE`, a destructive `ALTER`/`MODIFY COLUMN`
type change, `REVOKE`, or a `GRANT ... PUBLIC|ALL`) forces the tier to
`risk:boundary` regardless of the declared label.

### Fail-closed ambiguity

Any of the following is treated as `risk:boundary`, never defaulted to
`risk:routine`:

- An empty or malformed file list (`determinePathRisk` returns
  `malformed-or-empty-file-list`).
- A file entry missing a string `filename`.
- A migration file whose patch/content is unavailable, because reversibility
  cannot be established.
- A path that does not match any known routine or sensitive pattern
  (`classifyPathTier`'s final fallthrough).
- An issue-declared risk label that is not exactly one of the three known
  values (`normalizeIssueRiskLabel` treats it as invalid and boundary).
- A PR whose changed-file list carries more than one, or zero, risk labels
  on the issue side (`invalid-risk-label-count` at the queue-controller
  eligibility stage) -- such an issue is not queue-eligible at all.

There is no "unknown, assume safe" path anywhere in this contract.

## 7. Required checks by risk tier

`getRequiredChecks(tier, files)` in `agentic-factory-policy.cjs` computes the
required-check set:

| Tier | Baseline | + | + path-selected | + |
|---|---|---|---|---|
| `risk:routine` | `Quality and evidence gates`, `PostgreSQL migrations and execution`, `Agentic code review` | -- | `Security review` / `Trading safety review` if changed paths match (§8) | -- |
| `risk:sensitive` | same baseline | `QA verification` | same path-selected rule | -- |
| `risk:boundary` | same baseline | `QA verification` | same path-selected rule | `Human boundary approval` |

Path-selected specialist checks (`requiresSecurityCheck`,
`requiresTradingSafetyCheck`) are independent of tier: they trigger on the
specific changed/renamed paths (auth/admin routes, deployment code, secrets
example file, `.github/`, `specs/deployment.md` for security; trading,
guardrails, agent, db, backtest, tools code, migrations, and
`specs/rfcs/**` for trading safety) regardless of whether the overall tier is
routine or sensitive. A change can therefore require `Security review` even
at `risk:routine` if it touches one of those specific paths.

The **required check set for a PR is fixed at the moment its risk tier is
computed** and MUST be evaluated against the exact current head SHA. A check
that ran on a previous commit does not satisfy a required check after a new
commit lands, including a `[self-heal]` repair commit.

While a boundary PR waits for current-head human approval, the reconciler
publishes `Human boundary approval` and the dependent merge-policy verdict as
completed `action_required` checks. This keeps the gate fail-closed without
leaving checks falsely `in_progress` for days. A qualifying approval publishes
a newer successful verdict for the same exact head.

## 8. Review-requirement labels are not lifecycle state

`needs-qa`, `security-review`, and `trading-safety` are **review requirements,
not lifecycle states**. They MUST NOT appear in the lifecycle table (§5) or be
treated as a phase a PR "is in." They persist across PR head changes so the
reconciler can dispatch a fresh exact-current-head check. Each is:

| Label | Machine-readable check it gates | Deterministic clearer |
|---|---|---|
| `needs-qa` | `QA verification` (`QA_CHECK`) | A successful check on the exact current head clears the merge gate; a new head makes it pending again. |
| `security-review` | `Security review` (`SECURITY_CHECK`) | A successful check on the exact current head clears the merge gate; a new head makes it pending again. |
| `trading-safety` | `Trading safety review` (`TRADING_SAFETY_CHECK`) | A successful check on the exact current head clears the merge gate; a new head makes it pending again. |

A label is applied when its corresponding check becomes required and remains
until the lifecycle ends or a human explicitly changes scope. It causes the
reconciler to dispatch that check again whenever the PR head changes. If the
current-head conclusion cannot be resolved, merge MUST NOT proceed.

## 9. Claim / provenance nonce contract

A **claim** (lease) is how the queue controller guarantees at most one
in-flight implementation per issue. It is built and read exclusively through
`agentic-queue-controller.cjs`:

- **Nonce:** `buildClaimNonce({ runId, attempt, issueNumber })` returns
  `` `${runId}:${attempt}:${issueNumber}` ``. It is fully deterministic --
  the same three inputs always produce the same nonce, which is what makes a
  retried dispatch safe to re-run without creating a second claim.
- **Payload:** `buildClaimPayload({ runId, attempt, issueNumber, owner,
  expiresAt })` returns `{ nonce, owner, issueNumber, expiresAt }`. `owner`
  MUST be a non-empty string identifying the claiming session/workflow run;
  `expiresAt` MUST be a valid ISO-8601 timestamp.
- **Serialization:** claims are persisted via `serializeClaimPayload` /
  `parseClaimPayload` (e.g. as an issue comment or label metadata).
  `parseClaimPayload` never throws; a malformed serialized claim returns
  `{ valid: false, reason }` and MUST be treated as a hard failure, not an
  empty claim.
- **Evaluation:** `evaluateClaimState(claim, nowIso)` classifies a claim as:
  - `no-claim` -- issue is claimable.
  - `malformed-claim` -- present but invalid shape/owner/timestamp; **fails
    closed as blocking** (`active-claim`-equivalent). It is never treated as
    absent.
  - `unknown-now-fail-closed` -- `nowIso` itself is invalid; the claim is
    treated as blocking because staleness cannot be evaluated.
  - `claim-active` -- `expiresAt` is in the future relative to `now`;
    blocks selection (`active-claim`).
  - `claim-expired` -- `expiresAt` has passed; **does not itself make the
    issue selectable.** `evaluateEligibility` records
    `stale-claim-requires-recovery` in this case, which is itself a
    rejection reason. If the claim is still unassigned, the lifecycle
    reconciler blocks the issue and pauses the factory; a human must investigate
    and explicitly restore queue eligibility. Assigned/implementing work may
    continue after the original lease expires. There is no silent,
    automatic reclaim path.
- **Correlation:** `buildCorrelationId` reuses the same nonce formula so a
  queue-selection run can be correlated with its downstream dispatch/claim
  operations. `isIdempotentRetry(previous, current)` MUST be used before
  treating any retried dispatch as new work.

## 10. Exactly-one-PR invariant

At most one open PR may exist per issue at any time.

- `hasOpenPullRequest: true` on a candidate is an unconditional eligibility
  rejection (`already-has-open-pull-request`); the queue controller MUST
  NOT select an issue that already has an open PR.
- Only `lifecycle-reconciler` (via the `assignment-worker` -> implementation
  path) may cause a new PR to be opened for a given issue, and only after
  any previous PR for that issue is closed or merged.
- If a duplicate PR is ever detected for the same issue and correlation id
  (§9) -- e.g. from a retried dispatch that was not correctly recognized as
  idempotent -- `lifecycle-reconciler` MUST block every candidate, pause the
  factory, record all candidate PR numbers, and MUST NOT allow either to reach
  `factory:merged`. A human chooses the canonical PR.

## 11. Repair caps

Self-heal (`pr-self-heal`) repair attempts on an open, factory-owned PR are
capped by the PR's risk tier (§6), not by a single flat constant:

| Tier | Repair cap |
|---|---|
| `risk:routine` | 2 repair commits |
| `risk:sensitive` | 1 repair commit |
| `risk:boundary` | 0 -- no automatic repair is ever attempted |

This tiers the existing flat two-commit self-heal cap documented in
`docs/agentic-software-factory.md` by blast radius: a routine documentation
or UI fix keeps its existing 2-attempt budget; a sensitive/reversible change
gets exactly one attempt before requiring a human; a boundary change never
gets an automated retry at all -- any failing required check on a
boundary-tier PR routes straight to `ready-for-human-review` (or `blocked`,
if the reconciler cannot even establish that state safely).

Reaching a nonzero cap MUST apply `self-heal-exhausted` and
`ready-for-human-review` (never a silent close or merge). Boundary work is not
considered "exhausted": it is ineligible for repair from the outset and routes
directly to `ready-for-human-review`.

## 12. Concurrency, budget, and the evidence gate

- The goal's "Maximum active coding-agent sessions" field (`max_wip`, §3)
  bounds `currentInFlightCount` in `evaluateEligibility`: once
  `currentInFlightCount >= concurrencyLimit`, every remaining candidate is
  rejected with `concurrency-limit-reached`.
- The goal's "Assignment budget" field (`assignment_budget`, §3) bounds
  `currentBudgetUsed` the same way (`budget-limit-reached`). One budget unit
  is consumed per issue the queue controller successfully dispatches (moves
  to `factory:claimed`) under that goal; it is not consumed by selection alone
  in `shadow` mode. Human renewal is an explicit edit to the goal.
- **Starting value:** every goal's `max_wip` MUST start at `1` -- the
  template's own field description already states this ("Use 1 until
  concurrency graduation evidence passes").
- **Evidence gate to reach 2:** a goal's `max_wip` MUST NOT be raised above
  `1` (and never above `2` unless a new ADR revisits this contract) until
  all of the following hold and a `human-operator` records the increase by
  editing the goal issue's `max_wip` field (never by automation self-editing
  it):
  1. At least 10 consecutive eligible factory-dispatched issues reached
     `factory:done` after exact-SHA dev evidence, with **zero** cases of a
     human needing to override an autonomous merge decision after the fact.
  2. **Zero** stale-claim recoveries (§9) were required in that window.
  3. **Zero** `risk:boundary` misclassifications were discovered after the
     fact (i.e., no case where a change later found to be boundary-tier had
     been auto-merged as routine/sensitive).
  4. Dev evidence (§13) validated cleanly for every `factory:merged` change
     in that window -- no rollback was triggered by missing/mismatched
     evidence.
  A concurrency increase is never self-applied by the factory itself, even
  if it computes that all four conditions hold; it only ever recommends the
  increase for human sign-off.

## 13. Dev evidence contract

A merged, factory-owned change may be labeled `factory:deployed-dev` only
after the `deployment-reconciler` validates an immutable evidence report for
the **exact merged SHA**, reusing the path and gates ADR 0008 and
[`specs/deployment.md`](./deployment.md) already established:

- Evidence path: `<environment>/<release-sha>/<operation>/<job-execution-id>/report.json`,
  where `<environment>` is `dev` and `<release-sha>` is the exact commit SHA
  that `merge-policy` merged.
- Required evidence-producing operations for a factory-triggered dev
  deploy: `migrate-init`, `preflight`, and `target-smoke` at minimum (plus
  `verified-backup` when the change touches migrations per §6/§7's
  trading-safety path selection).
- **Fail-closed rule:** missing, unreadable, ambiguous, or SHA-mismatched
  evidence is never a pass. Pending evidence may remain `factory:merged` for
  at most six hours. After that deadline the lifecycle reconciler applies
  `blocked` and pauses the factory. When deployment reached shadow staging,
  the dev workflow itself must also execute and verify ADR 0008's
  disabled/manual rollback sequence.
- This is a **dev/staging-only** contract. It has no bearing on, and creates
  no path toward, production evidence or production promotion (§14).

## 14. Production and live-trading exclusions

The factory MUST NOT, under any factory mode, goal configuration, or
evidence-gate state:

- Trigger or approve `azure-deploy-prod.yml`, or any workflow run that
  targets the prod resource group/environment.
- Use the `production-promotion` identity/environment for anything beyond
  the forced-disable/rotation actions ADR 0008 already scopes it to.
- Activate a production schedule (Container Apps Job `Schedule` mode in
  prod) under any condition; production deploys always land
  disabled/manual per ADR 0008 item 12.
- Enable, configure, or invoke Coinbase AgentKit live execution, or take any
  action that moves Project Krypto past the ADR 0002 paper-trading boundary.
- Rotate or provision secrets, IAM roles, or Azure resource locks outside an
  explicitly human-triggered operator workflow.
- Treat a cleared evidence gate (§12), a high concurrency limit, or a clean
  autonomous track record as authorization for any of the above. Nothing in
  this contract creates an autonomous path to production or live trading;
  ADR 0002 and ADR 0008 §12 are not superseded by this ADR.

Production deployment and live trading are, and remain, human-only actions.

## 15. Pause triggers and human-only unpause

Automation (any factory workflow) MUST transition the factory from `active`
to `paused` (or `shadow`) immediately upon detecting any of the following,
and MUST record the trigger and evidence in an audit comment on the relevant
control/work issue:

- A `risk:boundary` classification is produced for a candidate under a goal
  whose `max_risk_tier` does not permit it (i.e., the path-risk floor, §6,
  exceeded what the goal authorized) -- this signals scope drift.
- A duplicate PR is detected for the same issue (§10 invariant violated).
- Claim mutation/verification or assignment dispatch fails, a stale
  unassigned claim is detected, or queue state cannot preserve exactly one
  lifecycle label.
- PR claim, native-parent, allowed-path, or risk provenance is malformed or
  escapes the approved issue/goal contract.
- Dev evidence (§13) fails, mismatches, or remains missing beyond six hours
  for a `factory:merged` change.
- Any PR exhausts its tier-specific repair cap or a completed repair run does
  not produce a recoverable new head.
- Any attempt -- successful or blocked -- to perform an action in the §14
  exclusion list.

Rolling unresolved-check trends, WIP/accounting reconciliation, cost, and
repair-exhaustion frequency are reported by the canonical governance/status
workflows. They are human-reviewed prerequisites for increasing concurrency;
they are not separate automatic pause rules beyond the per-event breakers
above.

**Automation may pause itself. Automation MUST NOT unpause itself.** Only a `human-operator` replacing the control issue's paused mode label with
`factory-mode:active` resumes dispatch and merge/deploy action. This holds
regardless of whether the triggering condition has since resolved.

## 16. Cross-references

- [ADR 0002 -- Paper trading before live AgentKit](./decisions/0002-paper-trading-before-live.md)
- [ADR 0005 -- Structured LLM intent + hard deterministic authorization](./decisions/0005-structured-llm-intent-authorization.md)
- [ADR 0008 -- Azure-native deployment architecture](./decisions/0008-azure-native-deployment-architecture.md)
- [ADR 0013 -- Safety-bounded autonomous agentic SDLC factory](./decisions/0013-autonomous-agentic-sdlc-factory.md)
- [`.github/BACKLOG_GOVERNANCE.md`](../.github/BACKLOG_GOVERNANCE.md) -- milestone, WIP, and unblock policy this contract's `allowed_milestones` field draws from.
- [`docs/agentic-software-factory.md`](../docs/agentic-software-factory.md) -- narrative operating model, state labels, and required repository settings.
- [`specs/deployment.md`](./deployment.md) -- the Azure dev/prod runbook and immutable evidence format §13 reuses.
- `.github/scripts/agentic-factory-policy.cjs` -- risk tiers, required checks, lifecycle transitions.
- `.github/scripts/agentic-queue-controller.cjs` -- claim/lease semantics, eligibility, and deterministic ordering.
