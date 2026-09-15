# Agentic Workflows Map

Project Krypto's software factory is a GitHub Agentic Workflows (GH-AW) system that turns proactive opportunity discovery, issues, labels, slash commands, pull requests, CI events, and schedules into a controlled SDLC loop.

The GH-AW workflows are intentionally event-driven: each has a narrow job,
read-only agent permissions, and safe outputs for repository writes. The
deterministic reconciler, queue controller, and E2E canary are traditional
Actions workflows with their own explicitly scoped permissions.

## End-to-end flow

```mermaid
flowchart TD
  subgraph Intake
    discover["opportunity-discovery<br/>weekly proactive PM/research"]
    issue["Issue templates<br/>bug / feature / task / docs / safety / factory"]
    manual["workflow_dispatch<br/>manual operator run"]
    slash["Slash commands<br/>/discover /research /rubber-duck /plan /release-readiness"]
    labels["State labels<br/>opportunity, needs-rubber-duck,<br/>ready-for-planning, ready-for-ai-dev,<br/>factory:claimed/implementing/pr-open/repairing,<br/>risk:routine/sensitive/boundary,<br/>needs-qa, security-review, trading-safety, docs-sync"]
    goal["factory:goal + factory:goal-approved<br/>human-approved scope/WIP/budget"]
    pr["Pull request events<br/>opened / synchronize / ready_for_review / labeled"]
    ci["CI workflow_run<br/>failed, cancelled, timed out"]
    schedule["Schedules<br/>status / governance / evals<br/>entropy / corrections"]
  end

  subgraph Planning
    pm["pm-triage<br/>Product Manager"]
    research["research-brief<br/>Researcher"]
    duck["rubber-duck-architecture<br/>Adversarial review"]
    em["em-planning<br/>Engineering Manager"]
  end

  subgraph Queue["Deterministic queue"]
    control["factory-control issue<br/>shadow / active / paused"]
    qc["factory-queue-controller<br/>15-min schedule, claim + nonce"]
  end

  subgraph Implementation
    impl["implement-ticket<br/>validates claim, no code edits"]
    assign["assign-to-agent safe output<br/>custom agent: project-krypto-dev"]
    draftpr["Coding-agent PR<br/>[ai-dev]"]
  end

  subgraph Review_and_QA["Review and QA"]
    code["code-review<br/>automatic PR review"]
    qa["qa-test-plan<br/>label-triggered QA"]
    sec["security-review<br/>label-triggered security"]
    trade["trading-safety-review<br/>label or high-risk path"]
    docs["docs-sync<br/>label-triggered docs/spec sync"]
  end

  subgraph Release
    rel["release-readiness<br/>operator handoff"]
    policy["Agentic merge policy<br/>conditional agent approval"]
    automerge["Native auto-merge<br/>all required checks pass"]
    human["Human veto / approval<br/>boundary / prod / live"]
    dev["Azure deploy dev<br/>exact main SHA, shadow + rollback"]
  end

  subgraph Operations
    status["daily-repo-status<br/>factory status issue"]
    governance["agentic-governance<br/>cost, outcomes, noise"]
    doctor["ci-doctor<br/>CI incident issue/comment"]
    reconcile["agentic-pr-reconciler<br/>checks / dispatch / policy"]
    lifecycle["agentic-lifecycle-reconciler<br/>claim / PR / merge / dev state"]
    sweeper["agentic-automerge-sweeper<br/>re-arms native auto-merge, never merges"]
    heal["pr-self-heal<br/>2 routine / 1 sensitive / 0 boundary"]
    e2e["agentic-sdlc-e2e<br/>manual docs canary"]
    evals["agentic-evals<br/>deterministic scorer"]
    entropy["harness-entropy<br/>report-only hygiene"]
    corrections["agentic-corrections<br/>report-only correction evidence"]
  end

  subgraph Safety["Safety boundaries"]
    readonly["Agent job is read-only"]
    safe["Safe outputs write<br/>comments / labels / issues / PRs"]
    codeowners["Path rules + merge policy<br/>specialist agent review"]
    caps["AI-credit caps + noop without issue spam"]
  end

  issue --> pm
  issue --> labels
  discover --> issue
  discover --> labels
  manual --> pm
  manual --> discover
  manual --> research
  manual --> duck
  manual --> em
  manual --> rel
  manual --> e2e
  manual --> qc
  slash --> discover
  slash --> research
  slash --> duck
  slash --> em
  slash --> rel
  labels --> research
  labels --> duck
  labels --> em
  labels --> qc
  labels --> qa
  labels --> sec
  labels --> trade
  labels --> docs
  goal --> qc
  pr --> code
  pr --> trade
  pr --> qa
  pr --> sec
  pr --> docs
  ci --> doctor
  pr --> reconcile
  ci --> reconcile
  schedule --> status
  schedule --> governance
  schedule --> qc
  schedule --> evals
  schedule --> entropy
  schedule --> corrections

  pm --> research
  pm --> duck
  pm --> em
  research --> em
  duck --> em
  em --> labels
  control --> qc
  qc --> control
  qc --> impl
  impl --> assign
  assign --> draftpr
  draftpr --> code
  code --> qa
  code --> sec
  code --> trade
  code --> docs
  draftpr --> reconcile
  draftpr --> lifecycle
  e2e --> reconcile
  reconcile --> heal
  heal --> draftpr
  code --> policy
  qa --> policy
  sec --> policy
  trade --> policy
  docs --> policy
  policy --> automerge
  policy --> sweeper
  sweeper --> automerge
  reconcile --> sweeper
  schedule --> sweeper
  policy --> human
  human --> automerge
  automerge --> lifecycle
  lifecycle --> dev
  dev --> lifecycle
  rel --> human

  readonly --> safe
  safe --> draftpr
  safe --> labels
  safe --> issue
  codeowners --> human
  caps --> status
  caps --> governance
```

## How GH-AW runs in this repo

1. Workflow source files live in `.github/workflows/*.md`.
2. `gh aw compile` generates `.github/workflows/*.lock.yml`.
3. GitHub Actions runs the compiled `.lock.yml` files.
4. The agent job reads repository context with scoped read permissions.
5. The agent requests visible changes through safe outputs.
6. Separate safe-output jobs apply those changes with narrowly scoped write permissions.

This is why workflow markdown is the source of truth, while lock files are committed generated artifacts for transparency.

`agentic-pr-reconciler.yml`, `factory-queue-controller.yml`,
`agentic-lifecycle-reconciler.yml`, and `agentic-automerge-sweeper.yml` are
traditional deterministic workflows.
Each loads only trusted default-branch scripts and never executes PR code.
`agentic-automerge-sweeper.yml` is a backstop that re-arms GitHub's native
auto-merge for enrolled pull requests whose required contexts are already
green on the current head; it holds no permission to merge, to push, or to
publish the `Agentic merge policy` verdict it reads, so branch protection
remains the enforcement point.
`agentic-sdlc-e2e.yml` is the narrow manual merge/review/self-heal canary;
`agentic-factory-full-e2e.yml` exercises the full goal-authorized issue-to-dev
path. `agentic-evals.yml` runs deterministic, read-only SDLC evaluation on a
manual/weekly schedule with no live-model call.

## SDLC lifecycle

| Stage | Main trigger | Workflow | Role | Output |
|---|---|---|---|---|
| Opportunity discovery | Weekly schedule, `/discover`, manual | `opportunity-discovery` | Trading Growth PM | At most one `[opportunity]` ticket behind rubber-duck review |
| Intake | New/reopened/labeled issue | `pm-triage` | Product Manager | Triage comment, labels, follow-up issues |
| Research | `/research`, `ai:research`, manual | `research-brief` | Researcher | Research comment or research follow-up issues |
| Challenge | `/rubber-duck`, `needs-rubber-duck`, manual | `rubber-duck-architecture` | Rubber Duck | `approve`, `revise`, or `block` review comment and next labels |
| Planning | `/plan`, `ready-for-planning`, manual | `em-planning` | Engineering Manager | Plan comment and direct native child issues under the approved goal (`ready-for-ai-dev` only when every queue-readiness field is complete) |
| Queue dispatch | 15-minute schedule, manual | `factory-queue-controller` | Deterministic Actions gate | Reads `factory-control` mode, claims one eligible issue, dispatches `implement-ticket` |
| Implementation | Queue-controller dispatch (`issue` + `claim_nonce`) | `implement-ticket` | Project Krypto Developer | Validates the claim, then `assign-to-agent` hands the issue to Copilot (`project-krypto-dev`); no direct PR |
| Coding-agent PR | Copilot coding-agent session | (Copilot, not a GH-AW workflow) | Project Krypto Developer | One `[ai-dev] ` PR referencing the claim and issue |
| PR review | PR opened/sync/reopened/ready | `code-review` | Code Reviewer | PR comment, specialist labels, follow-up issues |
| QA | `needs-qa`, manual | `qa-test-plan` | QA Engineer | Test plan comment or QA gap issues |
| Security | `security-review`, manual | `security-review` | Security Reviewer | Security review comment or follow-up issues |
| Trading safety | `trading-safety`, high-risk PR paths, manual | `trading-safety-review` | Trading Safety Reviewer | Safety review comment, labels, follow-up issues |
| Docs/spec sync | `docs-sync`, manual | `docs-sync` | Docs/Spec Writer | Docs PR, comment, or docs-gap issues |
| Release | `/release-readiness`, `release-readiness`, manual | `release-readiness` | Release Manager | Release checklist comment or blocker issues |
| CI incident | Failed/cancelled/timed-out `CI` workflow run | `ci-doctor` | CI Doctor | Incident issue/comment |
| PR reconciliation | PR/review/workflow events, 5-minute schedule | `agentic-pr-reconciler` | Deterministic Actions gate | Dispatch missing checks, publish merge policy, cap repair attempts |
| Lifecycle reconciliation | Issue/PR/dev-workflow events, 15-minute schedule | `agentic-lifecycle-reconciler` | Deterministic Actions gate | Verify claim/PR provenance, enroll native auto-merge, persist lifecycle transitions, close only after exact-SHA dev evidence |
| PR self-heal | Reconciler dispatch after a failed required check | `pr-self-heal` | Project Krypto Developer | One focused repair commit or blocked handoff |
| Dev delivery | Successful push CI on `main` | `azure-deploy-dev` | Deterministic deployment workflow | Exact-SHA shadow deployment, activation/schedule proof, `Dev deployment evidence`, fail-closed rollback |
| Factory E2E | Manual `happy-path` or `self-heal` dispatch | `agentic-sdlc-e2e` | Deterministic Actions canary | Required-context, repair, native auto-merge, and cleanup evidence |
| SDLC evaluation | Manual/weekly schedule | `agentic-evals` | Deterministic Actions scorer | Read-only eval report artifact; no live-model call |
| Factory entropy | Manual/weekly schedule | `harness-entropy` | Entropy Reporter | One report-only issue or noop; no fix authority |
| Correction evidence | Manual/weekly schedule | `agentic-corrections` | Correction Reporter | Trusted-human label correction metrics or noop |
| Status | Daily schedule/manual | `daily-repo-status` | Repo Status Reporter | Daily factory status issue |
| Governance | Weekly schedule/manual | `agentic-governance` | Governance Reporter | Cost/outcome/noise report issue |

## Trigger catalog

| Trigger | Activates | Notes |
|---|---|---|
| Weekly schedule | `opportunity-discovery` | Proactively creates at most one high-quality opportunity ticket behind rubber-duck review. |
| `/discover` | `opportunity-discovery` | Centralized slash command for human PM steering. |
| `opportunity` label | downstream review flow | Marks proactive opportunity tickets; rubber-duck decides whether to advance them to planning. |
| New/reopened issue | `pm-triage` | Product triage is the default intake path. |
| Any labeled issue | `pm-triage` | Lets PM refine state transitions after labels change. |
| `ai:research` label | `research-brief` | Requests evidence-backed research. |
| `needs-rubber-duck` label | `rubber-duck-architecture` | Runs adversarial review on issue or PR. |
| `ready-for-planning` label | `em-planning` | Breaks work into implementation-ready tickets; applies `ready-for-ai-dev` only when queue-readiness fields are complete. |
| `ready-for-ai-dev` label | `factory-queue-controller` (eligibility) | Makes the issue selectable by the queue controller; does **not** trigger `implement-ticket` directly. |
| 15-minute schedule, manual | `factory-queue-controller` | Reads `factory-control` mode, selects one eligible issue by deterministic priority/age order, claims it, dispatches `implement-ticket`. |
| Queue-controller `workflow_dispatch` (`issue`, `claim_nonce`) | `implement-ticket` | Sole legal caller; validates the claim then uses `assign-to-agent` for the Copilot coding agent. There is no `/implement` slash command and no direct label trigger. |
| `needs-qa` label | `qa-test-plan` | Runs QA/test-gap review on issue or PR. |
| `security-review` label | `security-review` | Runs security review on issue or PR. |
| `trading-safety` issue label | `trading-safety-review` | Runs trading/guardrail safety review for an issue. |
| `docs-sync` label | `docs-sync` | Runs docs/spec alignment review or docs PR. |
| `release-readiness` label | `release-readiness` | Produces release checklist for a PR. |
| `/research` | `research-brief` | Centralized slash command for issues/comments. |
| `/rubber-duck` | `rubber-duck-architecture` | Centralized slash command for issues/PRs/comments. |
| `/plan` | `em-planning` | Centralized slash command for issues/comments. |
| `/release-readiness` | `release-readiness` | Centralized slash command for issues/PRs/comments. |
| PR opened/synchronize/reopened/ready | `code-review` | Lightweight automatic review; can add specialist labels. |
| PR high-risk paths | `trading-safety-review` | Automatic for `src/trading/**`, `src/tools/**`, `src/guardrails/**`, `src/agent/**`, `src/backtest/**`, `src/app/api/agent/**`, `src/db/**`, `drizzle/**`, `supabase/migrations/**`, and `specs/rfcs/**`. PR label events are still path-scoped. |
| CI workflow failure | `ci-doctor` | Watches `CI` on `main` and `develop/**`. |
| PR/check/review event or 5-minute schedule | `agentic-pr-reconciler` | Restores missed CI/review dispatches, publishes merge policy, and dispatches bounded repair. |
| Issue/PR/Azure-dev event or 15-minute schedule | `agentic-lifecycle-reconciler` | Correlates the factory issue, claim, Copilot PR, merge SHA, and dev evidence without executing PR code. |
| Successful push CI on `main` | `azure-deploy-dev` | Deploys the exact CI-passed SHA to dev shadow, publishes a commit status and development Deployment, and verifies rollback on activation failure. |
| Manual factory E2E | `agentic-sdlc-e2e` | Updates one stable docs heartbeat through the happy path or deterministic self-heal path; never runs on a schedule or PR event. |
| Manual/weekly schedule | `agentic-evals` | Runs deterministic SDLC safety/contract fixtures and uploads an artifact; no model call. |
| Manual/weekly schedule | `harness-entropy` | Reports material harness entropy without fix authority. |
| Manual/weekly schedule | `agentic-corrections` | Reports PM-triage and specialist-label corrections from trusted-human label events. |
| Daily schedule | `daily-repo-status` | Creates or replaces daily factory status issue. |
| Weekly schedule | `agentic-governance` | Reports workflow health, cost, outcomes, and noise. |

## Centralized slash-command routing

The workflows that support slash commands use centralized routing. GitHub events first hit `.github/workflows/agentic_commands.yml`, which detects supported commands and dispatches the target workflow.

Supported commands:

| Command | Target workflow |
|---|---|
| `/discover` | `opportunity-discovery` |
| `/research` | `research-brief` |
| `/rubber-duck` | `rubber-duck-architecture` |
| `/plan` | `em-planning` |
| `/release-readiness` | `release-readiness` |

QA and docs-sync intentionally do not have slash commands. They are label-triggered to avoid expensive or noisy PR fanout. `implement-ticket` also has no slash command: it is dispatched only by `factory-queue-controller` with a claimed issue number and nonce, so a human cannot bypass the queue to assign work directly.

## Workflow catalog

The table below is generated from GH-AW source frontmatter. It covers the
agent workflows compiled from `.github/workflows/*.md`. Traditional
deterministic workflows — `factory-queue-controller`,
`agentic-pr-reconciler`, `agentic-lifecycle-reconciler`,
`agentic-sdlc-e2e`, `agentic-factory-full-e2e`, `agentic-evals`, and the
Azure deployment workflows — are not GH-AW sources; their behavior is
described in the SDLC lifecycle and safety sections. `agentic-evals` runs the
deterministic SDLC evaluation (see
[`../specs/agentic-sdlc-evaluation.md`](../specs/agentic-sdlc-evaluation.md))
on a manual/weekly schedule with read-only permissions and no live-model call.

<!-- generated:workflow-inventory:start -->

_Generated from `.github/workflows/*.md` frontmatter by `scripts/generate-agentic-docs.ts`. Do not edit by hand; run `npm run agentic:docs` after changing a workflow source._

| Workflow | Import | Primary triggers | Safe outputs | AI credits (run / day) |
|---|---|---|---|---|
| `agentic-corrections` | `Built-in prompt` | manual | `jobs`, `noop` | 1000 / 2500 |
| `agentic-governance` | `Built-in prompt` | manual | `jobs`, `noop` | 1000 / 2500 |
| `ci-doctor` | `Built-in prompt` | manual; workflow_run: CI | `jobs`, `noop` | 1200 / 3000 |
| `code-review` | `Built-in prompt` | manual; PR: opened, ready_for_review, reopened, synchronize | `add-comment`, `add-labels`, `create-issue`, `jobs`, `noop` | 1500 / 5000 |
| `daily-repo-status` | `Built-in prompt` | manual | `jobs`, `noop` | 1000 / 2500 |
| `docs-sync` | `docs-spec-writer.md` | manual; issue label: docs-sync; PR: labeled | `add-comment`, `create-issue`, `create-pull-request`, `noop`, `remove-labels` | 1400 / 3000 |
| `em-planning` | `engineering-manager.md` | manual; /plan; issue label: ready-for-planning | `add-comment`, `add-labels`, `create-issue`, `noop`, `remove-labels` | 1200 / 3000 |
| `harness-entropy` | `Built-in prompt` | manual | `jobs`, `noop` | 1000 / 2500 |
| `implement-ticket` | `project-krypto-dev.md` | manual | `add-comment`, `assign-to-agent`, `noop` | 500 / 1500 |
| `opportunity-discovery` | `trading-growth-pm.md` | manual; /discover | `jobs`, `noop` | 1000 / 2000 |
| `pm-triage` | `product-manager.md` | manual; issue: labeled, opened, reopened | `add-comment`, `add-labels`, `create-issue`, `noop`, `remove-labels` | 1000 / 3000 |
| `pr-self-heal` | `project-krypto-dev.md` | manual | `add-comment`, `add-labels`, `noop`, `push-to-pull-request-branch` | 2200 / 5000 |
| `qa-test-plan` | `qa-engineer.md` | manual; issue label: needs-qa; PR: labeled | `add-comment`, `create-issue`, `jobs`, `noop` | 1600 / 3500 |
| `release-readiness` | `release-manager.md` | manual; /release-readiness; PR: labeled | `add-comment`, `create-issue`, `noop` | 1200 / 3000 |
| `research-brief` | `researcher.md` | manual; /research; issue label: ai:research | `add-comment`, `create-issue`, `noop`, `remove-labels` | 1500 / 4000 |
| `rubber-duck-architecture` | `rubber-duck.md` | manual; /rubber-duck; issue label: needs-rubber-duck; PR: labeled | `add-comment`, `add-labels`, `noop`, `remove-labels` | 1200 / 3000 |
| `security-review` | `security-reviewer.md` | manual; issue label: security-review; PR: labeled | `add-comment`, `create-issue`, `jobs`, `noop` | 1500 / 3500 |
| `trading-safety-review` | `trading-safety-reviewer.md` | manual; issue label: trading-safety; PR: labeled, opened, reopened, synchronize (path-scoped) | `add-comment`, `add-labels`, `create-issue`, `jobs`, `noop` | 1600 / 4000 |

<!-- generated:workflow-inventory:end -->

## Label state model

Labels are workflow state transitions:

| Label | Meaning |
|---|---|
| `opportunity` | Proactive PM/research opportunity ticket; starts behind rubber-duck review. |
| `profit-hypothesis` | Hypothesis intended to improve risk-adjusted paper-trading performance. |
| `experiment` | Experiment or measurement-oriented implementation ticket. |
| `strategy-research` | Trading strategy or market research needed before implementation. |
| `factory:goal` | Marks a tracked issue as an autonomous factory goal. |
| `factory:goal-approved` | Human-applied only; authorizes descendant work inside that goal's scope, risk ceiling, WIP, and assignment budget. |
| `needs-triage` | Needs PM refinement. |
| `ai:research` | Needs researcher workflow. |
| `needs-rubber-duck` | Needs adversarial approach review. |
| `ready-for-planning` | Ready for EM planning. |
| `ready-for-ai-dev` | Every queue-readiness field is complete; eligible for `factory-queue-controller` selection. |
| `factory:claimed` | Queue controller selected this issue and issued a claim nonce; not yet assigned. |
| `factory:implementing` | `implement-ticket` assigned the issue to the Copilot coding agent; a session is open. |
| `factory:pr-open` | The coding agent's `[ai-dev] ` PR is open and under required checks. |
| `factory:repairing` | A capped, risk-tiered `pr-self-heal` attempt is in progress. |
| `risk:routine` | Reversible, low-blast-radius change; up to 2 self-heal commits. |
| `risk:sensitive` | Reversible but reviewable change; up to 1 self-heal commit; requires `QA verification` plus any path-selected specialist check, decided by agent-check consensus alone. |
| `risk:boundary` | Irreversible or control-plane/human-boundary change; 0 self-heal commits; requires current-head human approval in addition to every applicable check. |
| `needs-ai-review` | Needs automated review or follow-up review state. |
| `needs-qa` | Non-lifecycle requirement for `QA verification`; retained so every new PR head is reviewed. |
| `security-review` | Non-lifecycle requirement for `Security review`; retained so every new PR head is reviewed. |
| `trading-safety` | Non-lifecycle requirement for `Trading safety review`; retained so every new PR head is reviewed (also auto-selected by high-risk paths). |
| `docs-sync` | Needs docs/spec alignment. |
| `release-readiness` | Needs release handoff/checklist. |
| `ready-for-human-review` | Boundary-tier work, exhausted repair, or an explicit reconciler failure; automation is done, a human should review. |
| `blocked` | Hard stop; only a human may resume out of it. |
| `factory:merged` | Merged by the deterministic merge policy or human boundary approval. |
| `factory:deployed-dev` | Dev evidence validated for the exact merged SHA. |
| `factory:done` | Terminal; no further factory action occurs. |
| `agentic-automerge` | Agent PR is enrolled in reconciliation and native auto-merge. |
| `self-heal-exhausted` | Repair stopped after the tier's cap (routine 2, sensitive 1, boundary 0 commits). |

## Safety and governance model

The factory is designed to automate work without letting the agent directly mutate the repository.

- **Read-only agent jobs:** workflow `permissions` keep the agent job read-scoped.
- **Safe outputs:** comments, labels, issues, and PRs are applied by separate safe-output jobs.
- **Goal-bound discovery:** no issue is selectable by the queue controller without an active, human-approved `factory:goal` + `factory:goal-approved` ancestor whose allowed scope, risk ceiling, WIP, and assignment budget still cover it.
- **One issue in flight at a time:** `factory-queue-controller` claims and dispatches at most one eligible `ready-for-ai-dev` issue per pass, and `implement-ticket` never edits code or opens a PR itself — it hands off to the Copilot coding agent via `assign-to-agent`, which opens exactly one `[ai-dev] ` PR.
- **Native auto-merge:** the coding agent's PR enrolls in auto-merge, while every same-repository PR requires CI, current-head code review, conversation resolution, and the deterministic merge-policy status.
- **Tiered required checks:** `risk:routine` requires baseline CI + `Agentic code review`; `risk:sensitive` also requires `QA verification` plus any path-selected `Security review`/`Trading safety review` (independent agent-check consensus is sufficient — no human review is required to merge); `risk:boundary` requires the same checks **plus current-head human approval**, and is never auto-merged on agent checks alone.
- **Bounded, tiered self-heal:** eligible agent PRs receive at most 2 (`risk:routine`), 1 (`risk:sensitive`), or 0 (`risk:boundary`) focused repair commits before being blocked; `.github/**`, `infra/**`, `specs/**`, package manifests, environment files, and PRs already carrying `ready-for-human-review` are excluded structurally.
- **Allowed paths:** every approved goal and queue-ready issue declares exact
  files or terminal `path/**` globs. Child patterns cannot widen the goal, and
  the lifecycle reconciler compares every current/previous PR filename against
  the issue contract before enrollment. The custom agent is also forbidden
  from editing factory control, branch protection, production/live, secret, or
  permission boundaries.
- **Protected files:** protected file changes fall back to issues instead of being silently committed.
- **Specialist reviews:** security and trading-safety checks are selected deterministically from changed paths; QA and docs remain label-driven. `needs-qa`, `security-review`, and `trading-safety` are persistent review requirements (not lifecycle state), so the reconciler requests a fresh check on every new head.
- **High-risk paths:** trading-safety review runs for trading, agent, guardrail, backtest, DB, migration, and RFC paths.
- **Human control:** a current-head change request or blocking label vetoes agent approval; humans retain deployment, live-trading, secret, and architecture-decision authority, and are the only actors who may return a paused factory to `active`.
- **Factory modes:** the singleton `factory-control` issue's mode label (`factory-mode:shadow`/`active`/`paused`) gates the queue controller and the merge policy; missing, duplicate, or conflicting mode labels fail closed to `paused`. Automation may pause itself on a detected safety trigger; it may never unpause itself.
- **Opportunity discovery:** creates software tickets and experiments behind rubber-duck review; it does not provide trading advice, execute trades, or bypass safety review.
- **Cost/noise controls:** workflows use `max-ai-credits`, `max-daily-ai-credits`, deduplication where appropriate, and `noop.report-as-issue: false`. Status and governance reports update one canonical tracking issue each, including an autonomy-funnel count per lifecycle label and a hard-invariants check, instead of creating a new issue every run.

Required repository configuration: native auto-merge enabled; strict required checks for both CI jobs, `Agentic code review`, and `Agentic merge policy`; zero unconditional approving reviews; required conversation resolution and admin enforcement enabled; force pushes and protected-branch deletion disabled. Conditional security and trading-safety checks, and boundary-tier human approval, are enforced through `Agentic merge policy`. Separately, repository Environments split human-gated deploy scope from the one environment (`development`) the factory may mutate autonomously — see [`specs/deployment.md`](../specs/deployment.md) §2.

GitHub Actions must be allowed to create pull requests while default workflow permissions remain read-only. For trusted enrolled same-repository agent PRs, held CI runs are approved and held agentic-review runs are replaced by a PR-head manual review dispatch; neither condition is treated as a code failure or sent to self-heal.

## Typical paths

### Feature or bug

1. User opens a bug/feature/task issue inside an active, human-approved `factory:goal` + `factory:goal-approved` scope.
2. `pm-triage` refines it and labels the next state.
3. Optional `research-brief` or `rubber-duck-architecture` runs.
4. `em-planning` decomposes larger work into leaf tickets with an explicit risk tier, and applies `ready-for-ai-dev` only when every queue-readiness field is complete.
5. `factory-queue-controller` selects the issue (one at a time, only in `active` mode), claims it with a nonce, labels it `factory:claimed`, and dispatches `implement-ticket`.
6. `implement-ticket` validates the claim and uses `assign-to-agent` to hand the issue to the Copilot coding agent (`project-krypto-dev`), which opens exactly one `[ai-dev] ` PR.
7. `code-review` reviews the PR automatically.
8. Deterministic path rules trigger security/trading-safety checks; labels trigger QA/docs review as needed. `risk:routine` needs only CI + code review; `risk:sensitive` also needs `QA verification` plus any selected specialist check (agent-check consensus, no human review required); `risk:boundary` needs the same checks plus current-head human approval.
9. The reconciler dispatches missing checks and risk-tiered bounded self-heal (2/1/0 repair commits) when needed.
10. Same-repository changes merge when all required checks pass (plus human approval at the boundary tier); forks still require human approval regardless of tier.

### Proactive opportunity

1. `opportunity-discovery` runs weekly or when a human uses `/discover`, gated on an active `factory:goal-approved` ancestor with remaining WIP/assignment budget (the legacy 20-open-`opportunity` count is a secondary ceiling; see [`.github/BACKLOG_GOVERNANCE.md`](../.github/BACKLOG_GOVERNANCE.md)).
2. It creates at most one `[opportunity]` issue with `needs-rubber-duck`.
3. `rubber-duck-architecture` decides whether to advance each ticket to planning or block/revise it.
4. `pm-triage` and `em-planning` refine approved tickets and set an explicit risk tier.
5. `ready-for-ai-dev` tickets wait for `factory-queue-controller` selection; trading or risk-sensitive work must also pass trading-safety review before merge.

### High-risk trading change

1. PR touches an automatic trading-safety path: `src/trading/**`,
   `src/tools/**`, `src/guardrails/**`, `src/agent/**`, `src/backtest/**`,
   `src/app/api/agent/**`, `src/db/**`, `drizzle/**`,
   `supabase/migrations/**`, or `specs/rfcs/**`.
2. `trading-safety-review` runs automatically and emits the `Trading safety review` check; path selection or the retained requirement label causes a fresh review on every new head.
3. It classifies the change as safe, safe-with-required-fixes, or unsafe.
4. The required merge-policy status stays pending until the current-head trading-safety check is `safe`; if the issue/PR also carries `risk:boundary`, a current-head human approval is required in addition.

### CI failure

1. `CI` completes with failure, cancellation, timeout, or action-required on `main` or `develop/**`.
2. `ci-doctor` inspects the failure.
3. It creates a deduplicated incident issue, comments on an existing target, or noops for duplicate/self-recovered failures.

### Agent PR check failure

1. The reconciler observes failed CI or an `Agentic code review` failure on an enrolled agent PR.
2. `pr-self-heal` inspects the evidence and may push one focused repair commit, bounded by the PR's risk tier (2 for `risk:routine`, 1 for `risk:sensitive`, 0 for `risk:boundary`), never touching `.github/**`, `infra/**`, `specs/**`, package manifests, or environment files.
3. CI and review rerun on the new head.
4. After the tier's repair cap is exhausted, or one no-change repair run, the PR is labeled `self-heal-exhausted` and `blocked`.

### Manual merge/review canary

1. An operator dispatches `agentic-sdlc-e2e.yml` from `main` in
   `happy-path` or `self-heal` mode. The workflow is portable — it has no
   hardcoded repository owner, so it runs unmodified in a fork or renamed
   repository.
2. The workflow creates an enrolled `github-actions[bot]` PR that changes only
   `docs/e2e/factory-heartbeat.md` and invokes the reconciler.
3. It requires successful `Quality and evidence gates`,
   `PostgreSQL migrations and execution`, `Agentic code review`, and
   `Agentic merge policy` contexts on the current head.
4. After observing a fully settled head, it holds merge policy pending, enables
   native auto-merge, and lets the reconciler restore success. Self-heal mode
   additionally requires an initial review failure, a
   `[self-heal]` commit, and removal of the deterministic marker.
5. Only after those assertions and the full check suite settle does the E2E
   workflow place a temporary pending merge-policy hold and enable native
   auto-merge; the reconciler must restore the passing policy status.
6. Success leaves one updated heartbeat on `main`; cleanup deletes the branch,
   and failure also closes any open canary PR.

This canary exercises the merge/review path only. It is not the full
issue-to-coding-agent cycle canary described next.

### Full issue-to-coding-agent cycle canary

1. `agentic-factory-full-e2e.yml` runs on `workflow_dispatch` (with a
   `goal_issue` input) or a weekly schedule gated on a human-set
   `FACTORY_CANARY_GOAL` repository variable.
2. It rejects the run unless the referenced goal issue is open,
   milestone-bound, and carries `factory:goal` + `factory:goal-approved`,
   and unless exactly one `factory-control` issue exists with
   `factory-mode:active`; it never authorizes or self-applies goal approval
   itself.
3. It creates a `risk:routine` canary issue as a sub-issue of that goal,
   scoped to touch only `docs/e2e/factory-full-heartbeat.md`, and dispatches
   `factory-queue-controller.yml`.
4. It polls for up to 330 minutes until the canary issue reaches
   `factory:done` (closed), failing immediately on a `blocked` label. Reaching
   `factory:done` requires the merge to have already passed through
   `factory:deployed-dev`; the workflow independently re-verifies that
   evidence — a successful `Dev deployment evidence` status and a successful
   `development` Deployment on the exact merge SHA — rather than trusting the
   label alone, recording the outcome in
   [`docs/e2e/factory-full-heartbeat.md`](../docs/e2e/factory-full-heartbeat.md).
5. Because it depends on the queue controller claiming and dispatching
   `implement-ticket`, which assigns to the Copilot coding agent, a full
   passing run is evidence for the entire goal → queue-controller claim →
   `assign-to-agent` → coding-agent PR → merge → dev-evidence path in one
   pass. It contains no production path — it stops at exact-SHA dev evidence
   and never touches `production-deploy`/`production-promotion` or live
   trading.

### Operational reporting (MonitorOps)

Both scheduled reporters run the same deterministic, dependency-free collector
(`scripts/agentic/collect-factory-health.cjs`) as their first step, then only
summarize its normalized JSON snapshot. The collector:

- inventories every `.github/workflows/*.md` GH-AW source (plus the `agentic-evals`
  and `ci` Actions workflows) over an explicit closed UTC window — the last 24
  full hours for `daily`, the last 7 full days for `governance`;
- represents every active workflow, including zero-run workflows, and serializes
  unavailable cost/token/safe-output/correction telemetry as `null`, never `0`;
- computes a material-state hash and evaluates configured thresholds (repeated
  failure, WIP over cap, eval/harness failure, per-run AI-credit cap, telemetry
  missing across two published periods, and source/lock drift);
- treats the `<!-- factory-state-hash: ... -->` marker embedded in prior report
  issues as the authoritative published state, so a `cache-memory` miss never
  suppresses the next report.

`cache-memory` (90-day retention) stores only snapshots and watermarks. The
reporters are read-only toward GitHub, expose only the trusted collector and
snapshot reader on their bash allowlist, and publish a single recurring issue with
`close-older-issues`, `expires`, no @mentions, and no GitHub backlinks:

1. `daily-repo-status` reports concise existing-work changes (throughput, aging,
   blocked work, PR state) and never creates new feature scope.
2. `agentic-governance` reports full factory health, cost, and threshold
   breaches.
3. Each embeds the state-hash marker and calls `noop` when the material state is
   unchanged, so an idle week produces no issue.

### Report-only entropy (harness-entropy)

`harness-entropy` is a weekly (plus `workflow_dispatch`) **report-only** scan of
the factory's governance surfaces. It never invents or applies a code, policy,
instruction, or trading change — it may quote deterministic remediation for a
risky path but must not modify it or suggest bypassing review. Two deterministic,
dependency-free collectors run
before the agent summarizes anything:

1. the MonitorOps collector (governance mode) writes
   `/tmp/gh-aw/factory-health.json`;
2. `scripts/agentic/collect-agentic-entropy.cjs` consumes that snapshot and emits
   a versioned JSON manifest (`/tmp/gh-aw/entropy-manifest.json`).

The manifest reuses existing authorities rather than duplicating logic — the
canonical policy loader, the MonitorOps workflow inventory, and the supplied
MonitorOps snapshot (WIP, telemetry, repeated failures are read from the snapshot,
never re-queried from GitHub). It reports across explicit **dimensions** — policy
consistency, source/lock consistency, instruction/reference integrity,
architecture integrity, observability coverage, backlog hygiene, and
maintainability hotspots — with per-rule evidence and **no vanity aggregate
score**. Each violation carries its exact owning `path` and a `remediation`.

Rules split into two severities:

- **Zero-tolerance** (also enforced locally by `npm run entropy:check`, wired into
  `harness:check`): canonical policy valid, every active GH-AW source compiled
  with required generated support files, local instruction/doc references resolve,
  workflow imports exist, no prohibited live executor, and generated doc markers
  present.
- **Advisory** (report-only, never blocks CI): duplicated policy literals, stale
  actionable-opportunity WIP vs the policy cap, workflow telemetry coverage and
  repeated failures, architecture boundary hotspots, source files over the
  documented advisory line threshold (500), and TODO/FIXME/HACK markers. Backlog
  and telemetry rules report `unknown` when no MonitorOps snapshot is supplied,
  never a false zero.

The workflow exposes only the two trusted node collectors and `cat` on its bash
allowlist, a single `create-issue` safe output (max 1, `close-older-issues`,
90-day `expires`, no @mentions, no backlinks) plus `noop`, and `cache-memory`
with 90-day retention. It publishes at most one recurring `[factory-entropy]`
issue and embeds an `<!-- entropy-state-hash: ... -->` marker; the published
issue history is authoritative over cache, so a cache miss never suppresses a
report. It calls `noop` when there is no material delta and no actionable
violation.

### Staged CorrectionOps (agentic-corrections)

`agentic-corrections` is a weekly (plus `workflow_dispatch`) **staged,
report-only** loop that measures how often the factory's PM-triage and
specialist-routing label decisions were later corrected by a trusted human. It
improves measurement only — it never proposes or applies a code, policy,
instruction, label, or trading change. One deterministic, dependency-free
collector (`scripts/agentic/collect-agentic-corrections.cjs`) runs before the
agent summarizes anything and writes `/tmp/gh-aw/correction-report.json`.

Predictions are reconstructed from the real `gh aw logs --artifacts all` artifact
shape (`aw_info.json`, `safeoutputs.jsonl`,
`safe-outputs-items/safe-output-items.jsonl`, and the
`aw-prompts/prompt-import-tree.json` + `prompt.txt` instruction fingerprint), not
from model-authored markers:

- **PM triage** — requested `add-labels`/`noop` and the target issue;
- **Specialist routing** — requested `add-labels` limited to
  `security-review`/`trading-safety` as *semantic* routes, kept separate from the
  *immutable* routes derived from the PR's changed paths via the canonical
  reconciler (`.github/scripts/agentic-pr-reconciler.cjs`).

Trusted truth comes only from later GitHub label events authored by a
`User` collaborator with `admin`/`maintain`/`write` permission after the
prediction was applied; bots and untrusted users are provenance-only and never
scored, and a record with no trusted human action is `pending`, never a `match`.
A human removing a predicted specialist label is a semantic correction but never
weakens an immutable route — that is surfaced as a `> [!WARNING]` safety conflict.
The versioned report tracks match/mismatch/pending, correction rate (or `null` at
sample size `0`), immutable-route conflicts, and
instruction/workflow/model groupings, and stores no raw
issue/comment/prompt/event body.

The workflow exposes only the trusted node collector and `cat` on its bash
allowlist, read-only permissions, a single `create-issue` safe output (max 1,
`close-older-issues`, 90-day `expires`, no @mentions, no backlinks) plus `noop`,
and `cache-memory` with 90-day retention. It publishes at most one recurring
`[factory-corrections]` issue and embeds an
`<!-- correction-state-hash: ... -->` marker; the published issue history is
authoritative over cache, so a cache miss re-baselines without a false correction.
It calls `noop` when there is no new trusted correction evidence or no material
delta. A deterministic `npm run corrections:check` validates the diff engine
against committed contract fixtures and never contacts GitHub. It never scores or
learns around trading authorization, guardrails, leases, reconciliation, operator
pause, or the paper/live boundary.
