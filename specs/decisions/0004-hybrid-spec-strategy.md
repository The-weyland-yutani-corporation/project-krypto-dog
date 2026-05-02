# 0004 — Hybrid spec strategy (master + ADRs + RFCs + git tags)

- **Status:** Accepted
- **Date:** 2026-05-02
- **Deciders:** @VeVarunSharma

## Context

The project shipped v1 and v2 as separate, immutable spec files (`prd.v1.md`, `prd.v2.md`). The v2 doc was framed as a delta over v1. As we approach v3, two reasonable strategies present themselves:

1. **Versioned snapshot files (status quo)** — keep adding `prd.v3.md`, `prd.v4.md`, … each as a delta or full re-spec.
2. **Single master spec edited via git history** — one `prd.md`; versioning lives in git tags / branches.

Both have well-known trade-offs (see `specs/prd.md` history or the project plan that produced this ADR).

## Decision

Adopt a **hybrid strategy**:

1. `specs/prd.md` — single living master spec. Always reflects current shipped product. Updated in the same PR as the code change.
2. **Git tags** for snapshots — `git tag spec/v1`, `spec/v2`, … applied at the moment a milestone ships. `git show spec/v1:specs/prd.md` reproduces that snapshot losslessly without keeping multiple files at the top level.
3. `specs/decisions/NNNN-<slug>.md` — lightweight ADRs. One per significant decision. Captures the *why* that `git blame` cannot.
4. `specs/rfcs/NNNN-<slug>.md` — proposals for *future* changes before they ship. On accept, content lands in `prd.md`; the RFC is updated to "Accepted" and stays as a historical record of the proposal.
5. `specs/archive/` — holding pen for the original `prd.v1.md` and `prd.v2.md`, kept readable forever with banners pointing to `prd.md`.

## Consequences

- **Positive:** A new contributor reads exactly one file (`prd.md`) and knows the product. Auditors read ADRs to learn *why*. PMs read RFCs + PR diffs for in-flight changes.
- **Positive:** No file lies — the master spec moves with the code. The archive preserves history without ambiguity about what's current.
- **Positive:** Git tags give immutable spec snapshots without file proliferation.
- **Trade-off:** Requires discipline — every PR that changes shipped behaviour must touch `prd.md` and (often) add an ADR.
- **Trade-off:** "What changed in v2 vs v1?" requires `git diff spec/v1..spec/v2 -- specs/prd.md` rather than reading a delta PRD. This is a worse experience for non-engineers and is mitigated by:
  - The archived delta-style PRDs remain readable forever.
  - Major releases should produce a short summary in the relevant RFC's "Accepted" status block.

## Alternatives considered

- **Pure versioned snapshots (status quo):** rejected — fragmentation grows linearly with versions; readers must mentally merge v1 + v2 + v3 + …; drift between files is unaudited.
- **Pure master + git history only (no ADRs/RFCs):** rejected — rationale gets lost in commit messages; in-flight proposals have no place to live; reviewers can't easily see release-shaped deltas.
