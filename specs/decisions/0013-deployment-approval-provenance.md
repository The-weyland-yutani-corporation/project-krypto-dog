# 0013 — Deployment approval provenance and expiry

- **Status:** Accepted
- **Date:** 2026-08-16
- **Deciders:** @VeVarunSharma

## Context

Project Krypto already pins Azure mutations to an exact CI-passed commit and
image digest, keeps production disabled/Manual, serializes mutation workflows,
and persists a signed target-smoke binding before activation checks. Two
remaining ambiguities were unsafe:

1. the persisted smoke approval had no enforced lifetime; and
2. application code could not truthfully identify the human who approved a
   GitHub Environment deployment. `GITHUB_ACTOR` is the requester/workflow
   actor, not the environment reviewer.

The approval boundary must fail closed without adding a production promotion
path or weakening the existing lease, no-trade, journaling, or paper/live
boundaries.

## Decision

1. **GitHub Environment review is the human authority boundary.** `platform`,
   `production-deploy`, and the forced-disable-only `production-promotion`
   environment require the audited human reviewer ID for `@VeVarunSharma` and
   `prevent_self_review=true` and `can_admins_bypass=false`. Bot, application,
   team, unknown-user, empty, self-review-capable, administrator-bypass, or
   unexpected deployment-branch policies are rejected by the live API check in
   CI and rechecked immediately before every protected Azure login.
   GitHub's deployment/review record is the custody record for reviewer
   identity; application code must not persist `GITHUB_ACTOR` as a fake
   approver.

2. **The target-smoke approval is a machine attestation, not the human
   approval.** Its versioned HMAC binds every attributed field in the current
   activation contract: approval journal ID; database-binding, mode-mismatch,
   cron-run, and admin-run evidence IDs; target origin; exact release SHA;
   exact image digest; disabled rollout mode; keyed cron-secret binding; and
   canonical `approvedAt`. The journal `createdAt` is written from the same UTC
   timestamp and must match it exactly. Missing or malformed generated
   identifiers, missing fields, a missing/mismatched evidence row, or any
   post-signature field change invalidates the attestation.

3. **Approval lifetime is at most 24 hours.** Activation is valid from
   `approvedAt` through exactly `approvedAt + 24h`, inclusive. A timestamp one
   millisecond later is expired. Missing, noncanonical, row-mismatched, or
   future timestamps fail closed. Activation reads use one repeatable-read,
   read-only snapshot; concurrent approvals with the same latest persisted
   timestamp are ambiguous and rejected. The existing dev shadow schedule path
   reruns activation-check in its mutation job and revalidates current-time
   expiry immediately before monitoring and rollout mutations.

4. **Existing workflow evidence remains independently bound.** The current
   activation contract has no migration or aggregate configuration digest to
   default or invent. Migration/init, verified-backup, target-smoke, and
   activation reports remain separately bound to immutable
   environment/release/operation/execution paths and validated before use.
   Any future promotion contract must explicitly add and sign new digest fields
   rather than synthesizing success-shaped values.

5. **Rollback ownership and evidence custody are explicit.** The production
   rollback owner is `@VeVarunSharma`, acting through the separately protected
   forced-disable boundary. If that account requested the mutation, a distinct
   audited human must be authorized before approval; self-review is never
   bypassed. GitHub retains deployment/review provenance, workflow artifacts
   retain redacted reports for their configured retention, and immutable Azure
   evidence storage remains the report custodian. Release evidence is indexed
   through issue #76.

Production promotion remains unimplemented. This decision does not enable a
schedule, change rollout mode, deploy Azure resources, or authorize PAPER/live
trading.

## Consequences

- **Positive:** stale, future, malformed, replay-copied, concurrently ambiguous,
  and field-mutated smoke attestations are denied deterministically.
- **Positive:** reviewer authority is enforced where the reviewer identity
  actually exists, with immutable organization/repository IDs.
- **Trade-off:** a mutation requested by the sole configured reviewer is
  intentionally blocked until a separately authorized human reviewer is added.
- **Follow-up:** any production promotion design must define its additional
  migration/configuration/evidence digests and receive separate trading-safety
  review; this ADR does not implement that path.

## Alternatives considered

- **Persist `GITHUB_ACTOR` as approver:** rejected because it records the
  requester, not the GitHub Environment reviewer.
- **Allow clock skew or default a missing timestamp:** rejected because either
  extends authority beyond the audited approval or creates a success-shaped
  fallback.
- **Consume the approval in application state:** rejected because
  activation-check is intentionally read-only and production mutation
  serialization/approval remains a GitHub workflow responsibility.
