# Agentic Software Factory

Project Krypto uses GitHub Agentic Workflows (GH-AW) as the backbone for an event-driven SDLC factory.

For the full workflow trigger map, Mermaid diagram, workflow catalog, and safety model, see [`agentic-workflows-map.md`](./agentic-workflows-map.md). For the normative, machine-oriented rules this narrative summarizes, see [`specs/agentic-factory-contract.md`](../specs/agentic-factory-contract.md) and [ADR 0013](../specs/decisions/0013-autonomous-agentic-sdlc-factory.md).

## Operating model

Work flows through small, safe automation loops, bounded by a human-approved
factory goal:

1. A human creates and approves a factory goal issue (`factory:goal` +
   human-applied `factory:goal-approved`) stating allowed scope,
   machine-readable allowed paths, non-goals, maximum risk tier, WIP, and
   assignment budget. Nothing downstream is authorized without it.
2. Proactive PM/research discovery creates evidence-backed opportunity
   tickets inside that goal's allowed scope, and stops when the goal's WIP
   allowance is reached (the legacy 20-open-`opportunity` count remains only
   as a secondary absolute ceiling; see [`.github/BACKLOG_GOVERNANCE.md`](../.github/BACKLOG_GOVERNANCE.md)).
3. Research creates evidence-backed briefs.
4. Product management converts ideas into implementation-ready issues, each
   linked to the approved parent goal.
5. Rubber-duck review challenges approach and risk.
6. Engineering management breaks approved work into sequenced, leaf tickets
   with an explicit risk tier, machine-readable allowed paths, and every
   queue-readiness field complete, and applies `ready-for-ai-dev` only when
   they are.
7. A deterministic queue controller (`factory-queue-controller.yml`/runtime,
   reading a singleton `factory-control` issue for its `shadow`/`active`/
   `paused` mode) selects **one** eligible `ready-for-ai-dev` issue at a
   time, issues a claim nonce, labels it `factory:claimed`, and dispatches
   `implement-ticket`.
8. `implement-ticket` no longer edits code or opens a pull request itself.
   It validates the claim (nonce, lease, goal approval, readiness) and, if
   every invariant holds, uses the `assign-to-agent` safe output to hand the
   issue to the Copilot coding agent under the `project-krypto-dev` custom
   agent. The coding-agent session opens exactly one `[ai-dev] `-prefixed
   pull request.
9. CI and agentic code review run on every current PR head.
10. A capped, risk-tiered self-heal loop may repair failed checks on
    eligible agent PRs: 2 repair commits for `risk:routine`, 1 for
    `risk:sensitive`, 0 for `risk:boundary` (no automated repair at the
    boundary tier).
11. A deterministic merge policy approves same-repository PRs once every
    required check passes on the exact current head: baseline CI + code
    review for `risk:routine`; plus `QA verification` and any
    path-selected `Security review` / `Trading safety review` for
    `risk:sensitive` (independent agent-check consensus, no human review
    required); plus current-head human approval for `risk:boundary`.
12. `needs-qa`, `security-review`, and `trading-safety` are review-requirement
    labels, not lifecycle states. They persist across PR head changes so the
    reconciler can rerun the matching exact-current-head check
    (`QA verification`, `Security review`, `Trading safety review`); that check
    result, not label removal, clears the merge gate.
13. `agentic-lifecycle-reconciler` independently binds the issue claim,
    Copilot assignee, exactly one `[ai-dev]` PR, merge SHA, and development
    evidence. It enrolls only matching claim provenance, enables native
    auto-merge without bypassing protection, and closes the issue only after
    the exact merge SHA passes `Dev deployment evidence` and a successful
    `development` Deployment.
14. A successful push CI run on `main` automatically invokes the exact-SHA dev
    shadow deployment. Any failed activation publishes failure evidence,
    verifies disabled/manual rollback when required, and pauses the factory.
    Production remains manual and human-protected.
15. Release readiness and governance/status workflows update one canonical
    tracking issue each with autonomy-funnel counts and hard invariants,
    rather than creating new issues every run.
16. Deterministic SDLC evals, report-only entropy, and staged CorrectionOps
    measure the factory without gaining implementation authority.

## State labels

Use labels as workflow state. These are the exact, durable lifecycle labels
(an issue/PR carries exactly one once past `needs-triage`):

| Label | Meaning |
|---|---|
| `needs-triage` | PM should refine the issue |
| `ready-for-planning` | EM should decompose work |
| `ready-for-ai-dev` | Eligible for queue-controller selection once readiness and goal authorization hold |
| `factory:claimed` | Queue controller selected this issue and issued a claim; not yet assigned |
| `factory:implementing` | Assigned to the Copilot coding agent; a session is open |
| `factory:pr-open` | The coding agent's `[ai-dev] ` PR is open under required checks |
| `factory:repairing` | A capped, risk-tiered self-heal attempt is in progress |
| `ready-for-human-review` | Boundary-tier work, exhausted repair, or an explicit reconciler failure |
| `blocked` | Hard stop; only a human may resume out of it |
| `factory:merged` | PR merged by the deterministic merge policy or human boundary approval |
| `factory:deployed-dev` | Dev evidence validated for the exact merged SHA |
| `factory:done` | Terminal; no further factory action occurs |

Risk labels (exactly one per work item; see `specs/agentic-factory-contract.md` §6):

| Label | Meaning |
|---|---|
| `risk:routine` | Reversible, low-blast-radius change |
| `risk:sensitive` | Reversible but reviewable change (trading/guardrail/agent/db/deployment code, dependency/infra manifests, most of `specs/`) |
| `risk:boundary` | Irreversible or control-plane/human-boundary scope; never auto-merged, never auto-repaired |

Goal-authorization labels (not lifecycle states):

| Label | Meaning |
|---|---|
| `factory:goal` | Marks a tracked issue as an autonomous factory goal |
| `factory:goal-approved` | Human-applied; authorizes descendant work under that goal. Only a human may add or remove it |

Review-requirement labels (not lifecycle states; retained so every new PR head
receives the required check):

| Label | Required check it gates | Merge-gate clearer |
|---|---|---|
| `needs-qa` | `QA verification` | Successful exact-current-head check |
| `security-review` | `Security review` | Successful exact-current-head check |
| `trading-safety` | `Trading safety review` | Successful exact-current-head check |

Remaining discovery/review/reporting labels:

| Label | Meaning |
|---|---|
| `opportunity` | Proactive PM/research opportunity ticket; starts behind rubber-duck review |
| `profit-hypothesis` | Hypothesis intended to improve risk-adjusted paper-trading performance |
| `experiment` | Experiment or measurement-oriented implementation ticket |
| `strategy-research` | Trading strategy or market research needed before implementation |
| `ai:research` | Research brief requested |
| `needs-rubber-duck` | Approach needs challenge review |
| `needs-ai-review` | PR needs automated review |
| `docs-sync` | Documentation/spec alignment required |
| `release-readiness` | Release manager review required |
| `agentic-automerge` | Agent-created PR opted into native auto-merge and reconciliation |
| `self-heal-exhausted` | Automatic repair stopped after the tier's retry cap |
| `report` | Canonical status/governance report issue |

## Approval model

Automation may create issues, comments, labels, and PRs through safe outputs
only. Same-repository PRs are approved by the deterministic merge policy
once every required check passes on the exact current head SHA:

- every PR requires CI and `Agentic code review`
- `risk:sensitive` PRs also require `QA verification`, decided by
  independent, current-head agent-check consensus — reversible/sensitive
  work does **not** require a human review to auto-merge
- auth, dependency, deployment, agent, skill, and workflow changes also
  require `Security review`; trading, guardrail, agent, backtest, database,
  migration, and trading RFC changes also require `Trading safety review`
- `risk:boundary` PRs require every applicable check above **plus a
  current-head human approval**; they are never auto-merged on agent
  checks alone and never receive automated repair

Humans may still veto a PR with a current-head change request or blocking
label, and retain control over:

- production deployment
- live-trading enablement
- secrets and external account configuration
- accepting architecture decisions
- unpausing the factory once automation has paused itself (automation may
  pause itself on a detected safety trigger; it may never unpause itself)

Review-requirement labels route a fresh current-head check; the successful
check clears the merge gate while the label remains for the next head. The
non-sensitive docs allowlist remains narrower than merge authority and is used
only for eligible repair scope.

## Commands

The first workflow set supports these slash commands:

| Command | Purpose |
|---|---|
| `/discover` | Ask the proactive PM/research agent to create opportunity tickets |
| `/research` | Create a research brief from an issue or comment |
| `/rubber-duck` | Challenge an approach before implementation |
| `/plan` | Ask EM to decompose a scoped issue |
| `/release-readiness` | Produce a release readiness checklist |

There is no `/implement` slash command. `implement-ticket` accepts only
`workflow_dispatch` with a required `issue` number and `claim_nonce`, so the
only legal caller is the queue controller; a human cannot dispatch it
directly without first forging a claim, which the workflow rejects.

QA and docs-sync are label-triggered with `needs-qa` and `docs-sync` so routine PRs do not fan out into expensive review loops.

## Readiness and intake recovery

The deterministic `factory-readiness.yml` runs daily and on manual dispatch
from trusted default-branch code with **read-only** permissions. It remains
useful while paused: it independently reports control-mode ambiguity, every
open goal's malformed/duplicate fields, native parent and milestone mismatches,
body and native blocking dependencies, claims, linked open PRs, WIP and consumed
assignment budget. It never calls selection, claims, or a mutation API.

The same report and dry-run recovery manifest are available locally:

```powershell
node .github\scripts\agentic-factory-readiness-cli.cjs --repo The-weyland-yutani-corporation/project-krypto-dog --json "$env:TEMP\factory-readiness.json" --markdown "$env:TEMP\factory-readiness.md"
```

`schemaVersion: 1` separates `hypotheticalReady` from `authorized`; neither
selects work. `completeness.errors` records inaccessible, malformed, capped or
incomplete API reads. Unknown capacity is `null`, not a healthy zero. CLI exit
code `2` means incomplete observation; a complete paused observation can exit
`0` without implying factory health. The JSON `disposition` and `pullRequests`
sections are **proposals only** (`apply: false`): existing claims, draft PRs,
blocked work and topology remain untouched. A wrong native parent is not
silently repaired from body text, and multiple approved goals are never
resolved by picking one.

Capacity identifies its canonical lifecycle-label accounting basis separately
from claim/assignee/open-PR ownership signals. Ownership not represented by
in-flight labels produces `wip-label-accounting-inconsistent` and requires
human reconciliation; a zero label count is not advertised as an empty system.

Capabilities include readable branch protection, Actions permissions, and
stage/default `GH_AW_*_COPILOT` model overrides. The pinned compiler's fallback
is reported separately from the effective configured model. Runtime support
and provider availability are independent, unverified dimensions until
source-addressed observations exist. Optional `--capability-evidence file.json`
accepts an array of `{model, layer, availability, observedAt, evidenceRefs}`
records; these remain historical observations, never authorization or a
timeless claim that a configured model works. No secrets are read or changed.

PM and EM now have one executable `apply_work_item` safe-output path, not
independent unrestricted create/label operations. Each pass validates the
current singleton human-approved goal, exact issue-form headings, declared
scope, path-risk floor, native lineage, milestone, dependencies, claims, open
PRs and capacity. It accepts only the triggering issue plus the exact original
body/`updated_at` snapshot. Incomplete, stale, blocked, boundary or
out-of-scope work fails closed with structured reasons.

When the approved goal's `Allowed scope` names particular source issues,
the queue also requires that scoped issue number or a derived leaf proven by
the listed anchor's trusted intake reservation/result receipts. A derived
leaf's single `Scope source: #N`, source issue, issue number and exact current
body hash must match those receipts. A copied body marker, a user-forged
comment or a later body change does not prove scope. PM cannot invent or change
the source to authorize unrelated work. This is additional narrowing evidence,
not approval: PM/EM still review the goal's Objective, Allowed scope
and Explicit non-goals for substantive relevance. A broad path allow-list or
an agent-created parent link never authorizes novel maintenance. Signal
fingerprints/evidence are preserved when a proposal needs a derived leaf.
Signals under an issue-bounded goal without that mechanical provenance remain
unproven; do not add a marker as a substitute for human goal rollover.
The signal adapter's versioned `factory-signal-admission:v1` receipt is also
accepted when the trusted workflow-authored comment on the goal-listed source
binds its source issue, emitted issue, current goal, fingerprint and exact body
SHA256 with `phase: native-linked`. Both source and emitted leaf must retain
their direct native goal relationship. This keeps a complete admitted signal
on the same implementing issue through PM and EM; no second issue is created.
An immutable derived leaf that needs revision must be re-planned from its
approved anchor; PM does not manufacture a second-generation scope proof.
Unproven goal-prose exceptions, including heartbeat scope without mechanical
evidence, require human scope clarification rather than a claimed live proof.

GitHub does **not** document conditional issue `PATCH` as compare-and-swap.
Accordingly intake never rewrites human-owned issue bodies/milestones or
reparents existing issues. When PM's complete proposal differs, it reserves
one bounded application and creates at most one immutable planning leaf,
sets the existing goal milestone at creation, and links that **new** leaf
directly to the goal (`replace_parent: false`). A leaf already matching the
proposal advances in place using only its legal lifecycle/risk/priority label
transition. Selective label operations preserve concurrent human hard stops;
pre/post reads refuse changed snapshots rather than replacing entire label
sets. EM verifies the materialized body without rewriting it, then advances
the leaf to the canonical `ready-for-ai-dev` label.

PM explicitly dispatches `em-planning.lock.yml` with the materialized issue
number. The existing scheduled queue controller observes final ready leaves.
Neither path relies on `GITHUB_TOKEN` label events recursively launching the
next stage. Intake/promotion and queue passes share a serialized concurrency
group. A durable `factory-intake:v1` reservation plus verified result receipt
prevents duplicate issue creation and dispatch on replay. These are **not**
factory claims or approval markers. Unknown delivery, interrupted application
or conflicting receipts require evidence-based human recovery, never a blind
retry, fake nonce, automatic unblock or replacement PR.

The operating objective is daily health visibility and at least one substantive,
verified dev improvement per week **when eligible authorized work exists**:
v2.1 safety/correctness first, then the standing human-approved
reliability/testing/maintenance goal. WIP remains one; twelve assignments per
human renewal is the proposed bounded goal configuration, not an automatic
budget edit. A human must resolve competing approvals and explicitly roll over
the goal before maintenance outside the existing goal can be admitted. Goal
approval, renewal, unpause, hard-stop recovery, boundary merge, architecture
acceptance, production/live operations, secrets and accounts remain human-only.

## Required repository settings

The autonomous path is fail-closed unless the repository is configured with:

- native auto-merge enabled
- strict required checks for `Quality and evidence gates`, `PostgreSQL migrations and execution`, `Agentic code review`, and `Agentic merge policy`
- zero unconditional approving reviews, because `Agentic merge policy` combines the current-head code-review and conditional specialist checks
- required conversation resolution and admin enforcement enabled
- force pushes and protected-branch deletion disabled
- default Actions workflow permissions set to read
- Actions allowed to create pull requests; approval is represented by required check runs and the deterministic merge-policy status rather than a GitHub review from the PR author
- a dedicated repository secret named `GH_AW_AGENT_TOKEN`, restricted to this
  repository and granted only the permissions required by GH-AW
  `assign-to-agent`; never reuse an Azure, production, or administrator token
- `factory-mode:shadow` retained until that credential completes one manual
  claim-to-Copilot-PR proof

Repository Environments (verified via the GitHub API) split human-gated from
autonomous scope: `production-deploy`, `production-promotion`, `platform`,
and `development-promotion` all carry human required-reviewer protection.
`development` carries only a branch policy — no required reviewer — and is
the sole environment the factory may mutate autonomously (see
[`specs/deployment.md`](../specs/deployment.md) §2). `development`,
`platform`, `production-deploy`, and `production-promotion` all accept
either `develop/azure` or `main` as their branch policy (`main` was added to
`development` to match the automatic exact-SHA dev deploy that follows
push-triggered CI on `main`); `development-promotion` alone still allows
only `develop/azure` and is not wired into any deployment workflow. No
environment named "production promotion" ships an executable promotion
workflow; the `production-promotion` identity/environment exists only for
forced-disable and rotation steps.

`FACTORY_CANARY_GOAL` is optional. Configure it only after a human-approved,
milestone-bound canary goal exists. Without it the scheduled full-cycle canary
job skips; manual dispatch still requires an explicit approved goal.

## Validation baseline

Implementation and QA workflows should use existing commands only:

```bash
npm run lint
npm run typecheck:scripts
npm run build
npm test -- --ci
```

## Agentic SDLC test suite

Run the deterministic unit, mocked-Octokit integration, and workflow-contract
tests locally:

```bash
npm run test:agentic-sdlc
```

These tests cover, across `agentic-factory-policy.cjs`,
`agentic-queue-controller.cjs`, and `agentic-pr-reconciler.cjs`:

- **Risk classification:** path-derived tier floor, issue-declared risk
  raise-not-lower, destructive-migration detection, and fail-closed
  behavior for malformed/unknown/empty input.
- **Queue/claim semantics:** eligibility rejection reasons, deterministic
  priority/milestone/age ordering, claim-nonce build/parse, and
  malformed/stale-claim fail-closed handling.
- **Lifecycle transitions:** every legal state/owner pair in the lifecycle
  table, illegal-transition rejection, and the human-only exit from
  `blocked`.
- **QA/specialist required checks:** required-check-set selection per risk
  tier and per path-selected specialist (`Security review` /
  `Trading safety review`), and the `QA verification` gate for
  `risk:sensitive`/`risk:boundary`.
- **Repair caps:** the tiered self-heal budget (routine 2 / sensitive 1 /
  boundary 0) and the forbidden-scope exclusions the reconciler and
  `pr-self-heal` enforce.
- Trusted identity and same-repository checks, current-head review state,
  blocking labels, held/missing workflow runs, and isolated API failures in
  `agentic-pr-reconciler.cjs`.

Workflow-contract tests keep the reconciler on a trusted default-branch
checkout and keep the E2E workflow manual-only.

After changing a GH-AW source or compiled workflow, also run:

```bash
gh aw compile --strict
```

### Agentic SDLC evaluations

The factory's own behavior (PM triage and specialist routing) is evaluated by a
deterministic, model-free scorer over a versioned, public-safe fixture corpus:

```bash
npm run agentic:evals          # score committed baselines, print a summary
npm run agentic:evals:check    # deterministic safety/contract gate (in harness:check + CI)
```

The gate is blocking: every `critical` safety/routing fixture must pass 100% and
the forbidden-action rate must be zero. Routing fixtures are scored by invoking
the canonical reconciler helpers, so the real routing policy is under test.
Scoring baseline observations verifies the scorer and the data contract only —
it does **not** run a model. Semantic prompt quality requires manual TrialOps
(`gh aw trial --repeat 3`) plus `npm run agentic:evals:compare`. The full
criteria, metrics, versioning, no-cherry-picking rules, and safety exclusions
are in [`../specs/agentic-sdlc-evaluation.md`](../specs/agentic-sdlc-evaluation.md).

### Report-only entropy

A weekly `harness-entropy` workflow scans the factory's governance surfaces and
publishes a single recurring report issue. The scan is deterministic and
dependency-free:

```bash
npm run entropy:collect        # write the JSON entropy manifest (stdout or --out)
npm run entropy:check          # fail only on zero-tolerance rules (in harness:check)
```

It reuses existing authorities (the canonical policy loader, the MonitorOps
workflow inventory, and the supplied MonitorOps snapshot) and reports across
explicit dimensions — policy consistency, source/lock consistency,
instruction/reference integrity, architecture integrity, observability coverage,
backlog hygiene, and maintainability hotspots — with per-rule evidence and no
single aggregate score. Zero-tolerance rules (policy valid, sources compiled,
references resolve, imports exist, no prohibited live executor, generated doc
markers present) run in `harness:check`; advisory findings (duplicated policy
literals, stale WIP, telemetry gaps, boundary hotspots, files over the documented
500-line advisory threshold, and TODO/FIXME/HACK markers) are report-only and
never block CI. The workflow is strictly report-only: it has no create-pull-request,
push, edit, or deletion output, publishes at most one issue, and never proposes or
applies a code, policy, or trading change. See
[`agentic-workflows-map.md`](./agentic-workflows-map.md) (Report-only entropy).

### Staged CorrectionOps

A weekly `agentic-corrections` workflow measures how often the factory's
PM-triage and specialist-routing label decisions were later corrected by a
trusted human. The scan is deterministic and dependency-free:

```bash
npm run corrections:collect    # write the JSON correction report (stdout or --out)
npm run corrections:check      # deterministic contract over committed fixtures (no gh)
```

The collector reconstructs each prediction from the real
`gh aw logs --artifacts all` artifact shape (`aw_info.json`, `safeoutputs.jsonl`,
`safe-outputs-items/safe-output-items.jsonl`, and the
`aw-prompts/prompt-import-tree.json` + `prompt.txt` instruction fingerprint) and
reconciles it against later GitHub label events authored by a trusted
`User` collaborator (`admin`/`maintain`/`write`) after the prediction was applied.
Bots and untrusted users are provenance-only and never scored; a record with no
trusted human action is `pending`, never a `match`. Semantic specialist routes
(from `security-review`/`trading-safety` labels) are kept separate from the
*immutable* routes derived from the PR's changed paths via the canonical
reconciler, and a human disagreement can never weaken an immutable route — it is
surfaced as a safety-warning conflict. The report tracks match/mismatch/pending,
correction rate (or `null` at sample size `0`), immutable-route conflicts, and
instruction/workflow/model groupings, storing no raw issue/comment/prompt/event
body. It is staged and report-only: no create-pull-request, push, edit,
`add-labels`, or
deletion output, at most one recurring issue, and it never scores or learns around
trading authorization, guardrails, leases, reconciliation, operator pause, or the
paper/live boundary. Confirmed corrections feed the eval corpus only through the
reviewed process in [`../specs/agentic-sdlc-evaluation.md`](../specs/agentic-sdlc-evaluation.md)
(§9). See [`../specs/decisions/0010-staged-correction-ops.md`](../specs/decisions/0010-staged-correction-ops.md).

Neither report-only loop can promote itself. Any future write authority must
satisfy the evidence and explicit human-decision gate in
[`../specs/decisions/0012-evidence-gated-automation-authority.md`](../specs/decisions/0012-evidence-gated-automation-authority.md).

### Mock-first application harness

The per-worktree application harness boots an isolated PostgreSQL database and
Next.js server with deterministic providers by default:

```bash
npm run harness:up
npm run harness:status
npm run harness:browser
npm run harness:down
```

Default mode is `disabled` with no Foundry, Coinbase, PostHog, or email calls.
Deterministic shadow scenarios remain no-trade. Real-provider smoke requires
`--allow-network-smoke`, stays `shadow`, calls only Foundry and Coinbase, and
never invokes execution. See
[`../specs/decisions/0011-mock-first-worktree-harness.md`](../specs/decisions/0011-mock-first-worktree-harness.md)
and [`../specs/local-testing.md`](../specs/local-testing.md).

### Manual merge/review canary

The traditional `Agentic SDLC E2E` workflow is intentionally
`workflow_dispatch`-only and portable (no hardcoded repository owner). Run
either mode from `main`:

```bash
gh workflow run agentic-sdlc-e2e.yml --ref main -f mode=happy-path
gh workflow run agentic-sdlc-e2e.yml --ref main -f mode=self-heal
```

This canary exercises the **merge and review path** only — required
contexts, bounded self-heal, and native auto-merge on a constrained,
same-repository docs PR. It is **not** the full issue-to-coding-agent
cycle canary; that is a separate workflow described next.

- `happy-path` creates a same-repository `github-actions[bot]` PR that changes
  only `docs/e2e/factory-heartbeat.md`, enrolls it with `agentic-factory`,
  `docs-sync`, and `agentic-automerge`, invokes the reconciler, verifies all
  four protected contexts plus a fully settled check suite, applies a
  pending-only E2E policy hold, and only then enables native auto-merge. The
  trusted reconciler releases the hold.
- `self-heal` adds the exact deterministic E2E marker. Code review must fail
  the initial head, `pr-self-heal` must remove only that marker in a
  `[self-heal]` commit, and all checks must pass on the repaired head before
  native auto-merge.

A successful run updates the stable heartbeat file on `main`, providing
auditable evidence without accumulating files. Cleanup deletes the canary
branch after success and closes any still-open PR before deleting the branch
on failure. A blocked label, missing required context, missing repair evidence,
or non-merged PR fails the run. The canary depends on the repository settings
listed above and never touches trading, auth, database, deployment, policy, or
workflow files.

### Full issue-to-coding-agent cycle canary

`agentic-factory-full-e2e.yml` exercises the complete goal-bound path: it
requires an explicit, already human-approved goal (`workflow_dispatch` with a
`goal_issue` input, or a weekly schedule gated on a human-set
`FACTORY_CANARY_GOAL` repository variable), rejects the run unless that goal
is open, milestone-bound, and carries `factory:goal` + `factory:goal-approved`,
and rejects it unless exactly one `factory-control` issue exists with
`factory-mode:active`. It then creates a `risk:routine` child canary issue as
a sub-issue of that goal (scoped to touch only
`docs/e2e/factory-full-heartbeat.md`), dispatches
`factory-queue-controller.yml`, and polls (up to 330 minutes) until the issue
reaches `factory:done` (closed). Reaching `factory:done` on the real lifecycle
graph requires the merged PR to have already passed through
`factory:deployed-dev` (§ State labels); the canary additionally re-verifies
that evidence directly — a successful `Dev deployment evidence` status and a
successful `development` Deployment on the exact merge SHA — rather than
trusting the label alone. A `blocked` label on the canary issue fails the run.
The result is recorded in
[`docs/e2e/factory-full-heartbeat.md`](../docs/e2e/factory-full-heartbeat.md).
It never authorizes or approves a goal itself — a human must already have
done that — so it cannot be used to bypass goal authorization, and it
contains no production path: it stops at exact-SHA dev evidence and never
touches `production-deploy`/`production-promotion` or live trading.

## Safety invariants

- v2 remains paper trading only.
- Live execution requires a separate RFC, architecture review, security review, trading-safety review, and human approval.
- No discovery, planning, or implementation work is selectable without an active, human-approved `factory:goal` + `factory:goal-approved` ancestor.
- Changes to trading, guardrails, auth, secrets, workflows, database state, deployment procedure, or operator behavior require current-head specialist agent checks selected from deterministic path rules.
- `risk:sensitive` (reversible) work merges on independent current-head agent-check consensus alone; `risk:boundary` (irreversible/control-plane) work additionally requires current-head human approval and never receives automated repair.
- The required `Agentic merge policy` check run remains pending until all applicable agent checks (and, at the boundary tier, human approval) pass; a human change request or blocking label still vetoes approval.
- Self-heal is capped by risk tier (routine 2, sensitive 1, boundary 0 repair commits) and structurally restricted to forbidden-scope exclusions (`.github/**`, `infra/**`, `specs/**`, package manifests, environment files, and unrelated files are never touched by a repair commit).
- Automatic deployment stops at exact-SHA `development` (shadow-only); production deployment and live trading remain human-only. See [`specs/deployment.md`](../specs/deployment.md) and [`specs/readiness.md`](../specs/readiness.md).
- Automation may pause itself on a detected safety trigger; only a human operator may return the factory to `active`.
- Opportunity discovery creates software tickets and experiments behind rubber-duck review; it does not provide trading advice, execute trades, or bypass safety review.
