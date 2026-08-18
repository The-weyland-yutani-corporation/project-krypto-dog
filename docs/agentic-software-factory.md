# Agentic Software Factory

Project Krypto uses GitHub Agentic Workflows (GH-AW) as the backbone for an event-driven SDLC factory.

For the full workflow trigger map, Mermaid diagram, workflow catalog, and safety model, see [`agentic-workflows-map.md`](./agentic-workflows-map.md).

## Operating model

Work flows through small, safe automation loops:

1. Proactive PM/research discovery creates evidence-backed opportunity tickets.
2. Research creates evidence-backed briefs.
3. Product management converts ideas into implementation-ready issues.
4. Rubber-duck review challenges approach and risk.
5. Engineering management breaks approved work into sequenced tickets.
6. Implementation agents open auto-merge-enabled PRs.
7. CI and agentic code review run on every current PR head.
8. A capped self-heal loop may repair failed checks on eligible agent PRs.
9. A deterministic merge policy approves same-repository PRs after current-head code review and any path-selected specialist checks pass.
10. QA and docs-sync remain label-driven; security and trading-safety are selected from changed paths.
11. Release readiness and governance workflows prepare operator handoff and track factory health.
12. Deterministic SDLC evals, report-only entropy, and staged CorrectionOps
    measure the factory without gaining implementation authority.

## State labels

Use labels as workflow state:

| Label | Meaning |
|---|---|
| `opportunity` | Proactive PM/research opportunity ticket; starts behind rubber-duck review |
| `profit-hypothesis` | Hypothesis intended to improve risk-adjusted paper-trading performance |
| `experiment` | Experiment or measurement-oriented implementation ticket |
| `strategy-research` | Trading strategy or market research needed before implementation |
| `needs-triage` | PM should refine the issue |
| `ai:research` | Research brief requested |
| `ready-for-planning` | EM should decompose work |
| `needs-rubber-duck` | Approach needs challenge review |
| `ready-for-ai-dev` | Implementation agent may open an auto-merge-enabled PR |
| `needs-ai-review` | PR needs automated review |
| `needs-qa` | QA/test-plan review requested |
| `security-review` | Security review required |
| `trading-safety` | Trading-safety review required |
| `docs-sync` | Documentation/spec alignment required |
| `release-readiness` | Release manager review required |
| `ready-for-human-review` | Human review gate |
| `agentic-automerge` | Agent-created PR opted into native auto-merge and reconciliation |
| `self-heal-exhausted` | Automatic repair stopped after the retry cap |

## Approval model

Automation may create issues, comments, labels, and PRs. Same-repository PRs
are approved by current-head agent checks:

- every PR requires CI and `Agentic code review`
- auth, dependency, deployment, agent, skill, and workflow changes also require `Security review`
- trading, guardrail, agent, backtest, database, migration, and trading RFC changes also require `Trading safety review`

The `security-review` and `trading-safety` labels route those specialist checks;
the labels are not permanent merge holds after their current-head checks pass.

The non-sensitive documentation allowlist is narrower than this merge policy:
it limits which enrolled agent PRs may receive self-heal commits, not which
same-repository PRs may be authorized by current-head agent checks.

Humans may still veto a PR with a current-head change request or blocking label,
and retain control over:

- production deployment
- live-trading enablement
- secrets and external account configuration
- accepting architecture decisions

## Commands

The first workflow set supports these slash commands:

| Command | Purpose |
|---|---|
| `/discover` | Ask the proactive PM/research agent to create opportunity tickets |
| `/research` | Create a research brief from an issue or comment |
| `/rubber-duck` | Challenge an approach before implementation |
| `/plan` | Ask EM to decompose a scoped issue |
| `/implement` | Ask an implementation agent to open an auto-merge-enabled PR |
| `/release-readiness` | Produce a release readiness checklist |

QA and docs-sync are label-triggered with `needs-qa` and `docs-sync` so routine PRs do not fan out into expensive review loops.

## Required repository settings

The autonomous path is fail-closed unless the repository is configured with:

- native auto-merge enabled
- strict required checks for `Quality and evidence gates`, `PostgreSQL migrations and execution`, `Agentic code review`, and `Agentic merge policy`
- zero unconditional approving reviews, because `Agentic merge policy` combines the current-head code-review and conditional specialist checks
- required conversation resolution and admin enforcement enabled
- force pushes and protected-branch deletion disabled
- default Actions workflow permissions set to read
- Actions allowed to create pull requests; approval is represented by required check runs and the deterministic merge-policy status rather than a GitHub review from the PR author

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

These tests execute the production reconciler module used by
`agentic-pr-reconciler.yml`. They cover trusted identity and same-repository
checks, the docs allowlist and sensitive-name denylist, current-head review
state, blocking labels, held/missing workflow runs, isolated API failures, and
the two-commit self-heal cap. Workflow-contract tests keep the reconciler on a
trusted default-branch checkout and keep the E2E workflow manual-only.

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

### Manual end-to-end canary

The traditional `Agentic SDLC E2E` workflow is intentionally
`workflow_dispatch`-only. Run either mode from `main`:

```bash
gh workflow run agentic-sdlc-e2e.yml --ref main -f mode=happy-path
gh workflow run agentic-sdlc-e2e.yml --ref main -f mode=self-heal
```

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

## Safety invariants

- v2 remains paper trading only.
- Live execution requires a separate RFC, architecture review, security review, trading-safety review, and human approval.
- Changes to trading, guardrails, auth, secrets, workflows, database state, deployment procedure, or operator behavior require current-head specialist agent checks selected from deterministic path rules.
- The required `Agentic merge policy` check run remains pending until all applicable agent checks pass; a human change request or blocking label still vetoes approval.
- Self-heal is limited to two repair commits and structurally restricted to the same non-sensitive documentation scope eligible for autonomous merge.
- Opportunity discovery creates software tickets and experiments behind rubber-duck review; it does not provide trading advice, execute trades, or bypass safety review.
