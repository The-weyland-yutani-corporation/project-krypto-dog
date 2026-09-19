# Bounded factory signals

This is an adapter to the existing [factory contract](./agentic-factory-contract.md),
not a new authorization hierarchy. It changes no goal approval, activation,
assignment budget, hard-stop recovery, merge gate, or production/live authority.
Boundary changes remain human-merged. No standing goal is inferred or approved.

## Cadence and authority

`factory-watchdog.yml` collects native GitHub health daily at 07:15 UTC and a
seven-day governance/entropy/correction receipt Monday at 07:30 UTC. It observes
while paused. Four owned canonical `report` issues record health, failure and
resolution without an LLM. A model outage cannot prevent those jobs from running.
The former scheduled GH-AW reports are now optional manual summaries; their
trusted pre-agent collection and artifact upload precede model execution.
Their `workflow_run` completion is also observed by the native watchdog.
That event is authorized in a read-only job before collection or publication.
Source runs must be allowlisted, same-repository and on the default branch.
Non-command human-triggered runs require current collaborator write/maintain/admin
authority; a command-capable source must have passed GH-AW activation (and thus
its membership gate), even when its dispatcher uses a maintainer's delegated
token. Skipped/denied command activation cannot trigger even a
missing-receipt fallback write. Authorized model failures remain observable.

Weekly substantive, dev-verified improvement is an **eligibility-dependent
objective**, not a guarantee or a reason to manufacture work. When a fresh
corroborated signal, current approved scope and free capacity exist, the watchdog
may dispatch one ordinary discovery pass. Otherwise it records the reason.
Reports, issue churn, heartbeat/canary changes and mere PR merges are not
substantive development outcomes. Runtime paper metrics remain unknown unless
their authoritative source is available; synthetic tests never prove edge.

Remaining v2.1 safety/correctness work comes first. Goal 248 explicitly names
its existing work anchors; its broad file paths do not authorize novel
maintenance. A future finite human-approved reliability/testing/maintenance
goal must explicitly name its finite source work. Twelve assignments is a
possible human renewal scale, **not** an adapter default or automatic renewal.
The adapter reads the existing lifetime budget and retains WIP1.

## Signal v1

`scripts/agentic/signal-contract.cjs` validates the exact object shape. Unknown
keys, incomplete evidence and malformed values fail closed. The outer payload
has exactly `signal` and `proposal` and is capped at 24,000 UTF-8 bytes.

| Signal field | Contract |
| --- | --- |
| `schemaVersion` | Exactly `1` |
| `fingerprint` | SHA-256 of `source.kind + ":" + source.key`; excludes window and SHA so a repeated problem does not create new work |
| `source` | Exactly `kind`, `key`, `ref`, `sha`, `windowStart`, `windowEnd` |
| `source.kind` | `workflow-run`, `repository-test`, `entropy-rule`, or `human-feedback`; unsupported write adapters reject explicitly |
| `source.key` | For runs, workflow file path without GitHub's terminal `@refs/...` suffix, plus `:` plus conclusion. For entropy, exact rule ID plus `:` plus owning path |
| `source.ref` | Same-repository GitHub run/issue/immutable-blob URL; never an arbitrary external destination |
| `source.sha` | Exact 40-character SHA; admission requires the current default-branch SHA |
| `source.windowStart`, `source.windowEnd` | Ordered closed-window UTC timestamps, end exclusive, at most seven days |
| `observedAt` | Valid timestamp; observation and window end must be no older than 24 hours; no material future timestamps |
| `severity` | `info`, `warning`, `error`, or `critical` |
| `evidenceRefs` | One to ten bounded same-repository GitHub URLs |
| `completeness` | Must equal `complete` for admission |
| `summary` | Bounded **untrusted data**, never an instruction or authority |

Current write adapters independently corroborate a failed native workflow run
or a currently reproduced local entropy rule. A run must still be the latest
matching-head/branch run; a superseded or recovered failure creates no work.
Workflow-path normalization removes only the documented ref suffix from a
YAML workflow path before identity/corroboration checks; unrelated `@` text is
preserved. The run's exact SHA, observation window and freshness still gate intake.
Human-feedback absence stays **pending** in CorrectionOps, never automated
truth. No adapter autonomously adopts prompts, policy, or evaluation truth.

## Proposal v1 and preflight

| Proposal field | Contract |
| --- | --- |
| `goalNumber`, `scopeIssueNumber` | Existing approved goal and existing direct native goal child. The source anchor must be explicitly named in the goal's Objective or Allowed scope |
| `title` | Bounded title, not executable input |
| `riskTier` | Existing canonical risk tier, at least the deterministic path floor and no higher than the approved ceiling; boundary proposals are not actuated |
| `allowedPaths` | One to twenty exact repository files, contained by the approved goal; no traversal or ambiguous wildcard scope |
| `dependencyNumbers` | At most ten issue numbers; every blocking dependency must resolve closed |
| `hypothesis` | Checkable expected causal improvement |
| `baseline`, `oracle` | Each has exactly `metric`, finite numeric `value`, `unit`, `evidenceRef` |
| `rollback`, `expectedOutcome` | Safe reversal and explicit desired result |
| `scope`, `nonGoals` | Bounded permitted work and exclusions |
| `acceptanceCriteria`, `validationPlan` | Checkable criteria and exact existing verification commands |

For workflow signals the corroborated baseline is `failing-workflow-runs: 1`,
unit `runs`, with target zero. Entropy signals use the reproduced
`rule-violations` count, unit `findings`, with target zero. The independent
oracle references an existing `tests/` file at the same immutable SHA, distinct
from the baseline run/finding reference. Matching targets is not proof until
post-merge independent evidence exists.

Preflight reuses current queue/runtime and policy parsers, the hypothetical
`evaluateEligibility` contract, and native API evidence. It requires:
complete bounded reads; fresh evidence; no prior fingerprint (open **or closed**);
active human-applied control; exactly one complete human-approved goal; explicit
goal scope and native ancestry; risk/path containment; known closed dependencies;
free WIP1 and lifetime assignment budget; and a successful, recent current-SHA
evaluation with no evaluation run in flight. Missing reads are not zero capacity.
Existing ready work and outstanding signal proposals reserve intake capacity.

## Write path and replay

Collectors only report. Opportunity Discovery and CI Doctor can emit exactly
one `submit_signal` safe output, consumed from a trusted default-branch checkout
by `signal-intake.cjs`. The mutating workflow serializes with the existing queue
controller and rechecks admission immediately before mutation.

The adapter creates at most one complete issue with the existing issue-form
headings, approved milestone, one risk label and **only `needs-triage`** as its
lifecycle label. It attaches and verifies the direct native goal parent, records
dispatch intent and explicitly dispatches `pm-triage.lock.yml` with `issue` and
`aw_context`. No ready label, claim, approval or merge is applied by this adapter.
Normal PM/EM/rubber-duck review owns subsequent progression.

Context retains `<!-- factory-signal:v1 FINGERPRINT -->`, a literal
`Scope source: #N` line and a bounded base64 copy of the versioned evidence.
After verifying the native link, the trusted controller posts a comment on the
**goal-listed scope source issue**, before PM dispatch:

```text
<!-- factory-signal-admission:v1 {"schemaVersion":1,"fingerprint":"HEX64","sourceIssueNumber":16,"issueNumber":503,"goalNumber":248,"bodySha256":"HEX64","phase":"native-linked"} -->
```

`bodySha256` hashes the entire emitted issue body as UTF-8. The comment contains
only that bare marker, without a quote, explanation or GH-AW footer. PM must
require `github-actions[bot]` authorship and immutable GitHub metadata
(`created_at == updated_at`) on that source-issue comment, matching native
goal/anchor/child/fingerprint and the child's exact current body hash. A copied
body marker, user-authored comment, or edited body is not scope proof. The source
discussion/body/topology is never rewritten. Native parents must match the
same repository URL, not merely an issue number from a different repository.

Native linkage or dispatch failure is explicit and retains the created issue
number. Ambiguous failures are **not automatically retried into a second issue
or session**. The persisted fingerprint makes replays non-mutating; the operator
must inspect incomplete handoff evidence. Blocked work is never cleared.

PM should reuse a complete admitted leaf. If its trusted intake materializes
a different implementation leaf, it must preserve the fingerprint/evidence and
record source-to-implementation mapping; the source discussion is not itself a
second ready implementation.

Local preview is read-only:

```text
node scripts/agentic/signal-intake.cjs payload.json
```

There is deliberately no local `--apply` switch.

## Outcome receipt

Observation links fingerprint -> goal/issue -> trusted claim nonce -> unique
same-repository PR/head/merged SHA -> genuine dev receipt -> measured outcome.
It consumes the additive
`.github/scripts/azure/dev-evidence.cjs` `readDevEvidence` capability when
available. Missing capability is explicitly `dev-evidence-reader-unavailable`,
with verified throughput **null**, not zero or success. Actual reader errors
fail collection; status-only `evaluateDevEvidence` is never a substitute.

For injected/offline callers, an omitted or `undefined` `evidenceReader` retains
production auto-loading. Explicit `null` forces the unavailable capability state;
an explicit function supplies the reader. Tests must select unavailable or
pending proof explicitly, not depend on which PRs are installed. The auto-loaded
reader receives the unchanged full GitHub SDK client, and its errors still fail
collection.

The genuine receipt binds dev environment, release SHA, web/ops image digests,
run/attempt, deployment/status IDs, immutable artifact identity/digest, and
required operation report paths/hashes. Wrong or missing SHA/environment cannot
count. Historical any-success cannot override a newer failure. Receipt delivery
and hypothesis success are separate: a workflow signal's measured result needs
a real, completed, independent post-merge workflow on the merged SHA. Other
unavailable post/runtime metrics remain pending, never synthetic successes.

## Offline contract

```text
npm test -- --runInBand tests/agentic-sdlc/signal-entry.integration.test.ts tests/agentic-sdlc/factory-watchdog.test.ts
```

`factory-signal-entry-canary.yml` runs this **offline** with read-only permissions,
through the real intake implementation and injected GitHub fixtures, not a
pre-created ready issue. It creates no live backlog, modifies no control and
does not replace the separate full issue-to-dev canary. A live canary must not
be run while paused. Genuine receipt integration additionally depends on the
human-merged dev-evidence reader and its own real ZIP contract tests.
