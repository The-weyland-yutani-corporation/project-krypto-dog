# 0010 — Staged, report-only CorrectionOps

- **Status:** Accepted
- **Date:** 2026-08-10
- **Deciders:** @VeVarunSharma

## Context

Project Krypto's agentic software factory makes two kinds of *labeling
decisions* that a human later confirms or overrides: PM triage state labels
(`pm-triage`) and specialist-review routing (`code-review`). We had no way to
measure how often those decisions were subsequently corrected by a trusted
human, so prompt/model changes could not be evaluated against real outcomes.

The factory already has two deterministic, dependency-free collectors —
MonitorOps (`collect-factory-health.cjs`) and entropy
(`collect-agentic-entropy.cjs`) — that run inside a trusted default-branch
checkout and feed a weekly report-only GH-AW workflow. We want a correction loop
built the same way, and we explicitly do **not** want a self-tuning loop in v1.

The safety kernel forbids learning around trading authorization, guardrails,
leases, reconciliation, operator pause, or the paper/live boundary
(`AGENTS.md`, `specs/agentic-sdlc-evaluation.md` §7). CorrectionOps must be
structurally incapable of touching those.

## Decision

Add a **staged, report-only** CorrectionOps collector
(`scripts/agentic/collect-agentic-corrections.cjs`) and a weekly GH-AW workflow
(`.github/workflows/agentic-corrections.md`) that measures — and only measures —
correction rate for two prediction sources:

1. **PM triage** — requested `add-labels`/`noop` and the target item, parsed from
   the real `gh aw logs --artifacts all` artifact shape (`aw_info.json`,
   `safeoutputs.jsonl`, `safe-outputs-items/safe-output-items.jsonl`, and the
   `aw-prompts/prompt-import-tree.json` + `prompt.txt` instruction fingerprint).
2. **Specialist routing** — requested `add-labels` limited to
   `security-review`/`trading-safety`, stored as *semantic* routes, kept
   **separate** from the *immutable* routes derived deterministically from the
   PR's changed filenames via the canonical reconciler helper
   (`.github/scripts/agentic-factory-policy.cjs`).

Trusted truth comes only from later GitHub label events authored by a
`User` collaborator with `admin`/`maintain`/`write` permission, after the
prediction was applied. Bots and untrusted users are retained as provenance
counts but never scored. A record with no trusted human action is `pending`,
never a `match`. The diff is deterministic, byte-stable, and field-level.

Immutable path routing is authoritative: a human removing a predicted specialist
label is a *semantic* correction but can never weaken or rewrite an immutable
route. Such a case is surfaced as a safety-warning conflict, not a routing
change.

The collector is read-only toward GitHub, stores only normalized prediction
snapshots, diffs, and watermarks in `cache-memory` (90-day retention), and never
persists raw issue,
comment, prompt, event, or review bodies. The published state hash embedded in
prior report issues (`<!-- correction-state-hash: ... -->`) is authoritative over
the cache, so a cache miss re-baselines without a false correction or a duplicate
issue. Confirmed human corrections feed the evaluation corpus only through the
documented, reviewed process in `specs/agentic-sdlc-evaluation.md`; corpus edits
are never automated.

## Consequences

- Positive: We can measure PM-triage and routing correction rate over an explicit
  weekly window, grouped by instruction/model version, without any live-model
  dependency in ordinary CI.
- Positive: The safety kernel is protected structurally — the scored vocabulary
  is limited to PM state labels and specialist routing, and immutable routes can
  never be weakened by disagreement.
- Positive: The deterministic `corrections:check` contract gate runs against
  committed fixtures and never contacts GitHub, so drift is caught locally.
- Negative / trade-offs: v1 measures only; it does not improve any prompt or
  policy. Deterministic fixtures do not test the live model (that is TrialOps).
- Follow-ups required: Any future promotion to a *change-proposing* loop is a
  separate ADR/RFC gated on the criteria in the implementation plan (100% critical
  safety evals, stable trials, complete telemetry, low correction/revert rates,
  proven rollback, explicit human approval).

## Alternatives considered

- **Model-authored correction metadata markers** — rejected. We reconstruct
  predictions from the authoritative `gh aw logs` artifact shape (safe outputs +
  applied items + prompt import tree), not from self-reported markers a run could
  fabricate.
- **Self-tuning correction loop in v1** — rejected. It would put agent-behavior
  learning next to the trading safety kernel with no measurement track record.
  Measurement first, authority later and separately.
- **Storing raw event/issue bodies for richer diffs** — rejected on privacy and
  safety grounds. Ids, labels, routes, counts, timestamps, and hashes are
  sufficient to score corrections.
