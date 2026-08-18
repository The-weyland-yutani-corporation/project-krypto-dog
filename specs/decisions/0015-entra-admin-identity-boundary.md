# 0015 — Microsoft Entra admin identity boundary

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** Project Krypto security, release, and trading-safety owners

## Context

The admin console used one shared password, an application-issued 24-hour
cookie, a per-replica in-memory limiter, and forwarded client addresses. That
model could not attribute a sensitive action to an immutable person, could be
bypassed across replicas, and made password possession sufficient for run,
resume, unlock, and lease-recovery operations.

The public site, health probes, and independently authenticated scheduler routes
must remain reachable, so a blanket redirect at ingress is not suitable. The
production boundary must remain repeatable in Bicep, preserve local fail-closed
testing, and add no live-trading authority.

## Decision

Azure Container Apps built-in authentication ("Easy Auth") with a single-tenant
Microsoft Entra web app is the production authentication boundary. The platform
sidecar validates the token and manages its host-bound secure session before the
request reaches Next.js. It is configured with `AllowAnonymous` only so public,
health, and machine routes retain their own policies; every `/admin/**` and
`/api/admin/**` request is still rejected by centralized application
authorization unless the platform supplied a valid Entra principal.

Application code consumes only `X-MS-CLIENT-PRINCIPAL`,
`X-MS-CLIENT-PRINCIPAL-ID`, and `X-MS-CLIENT-PRINCIPAL-IDP`. Container Apps
guarantees that external callers cannot set those headers. Production accepts
them only when `ADMIN_PLATFORM_AUTH=azure-container-apps`, and Bicep deploys the
matching `authConfigs/current` resource in the same change. The application does
not consume forwarded IP addresses or raw provider access/ID tokens. It rejects
malformed principals and independently binds mapped claims to the exact tenant,
v2 issuer, audience, object ID, subject, platform principal ID, token/session
times, app role, and reviewed allowlist.

The allowlist is a reviewed array of immutable Entra object IDs, human-readable
operator labels, and one role: `OPERATOR`, `RELEASE_OWNER`, or
`SAFETY_APPROVER`. Human-readable claims such as email or UPN are display-only
and never authorize. The token must carry the corresponding app role.
Release-owner or safety-approver role is required for unlock and lease recovery;
all web mutations require recent authentication.

Routine access requires either Entra `amr=mfa` or the dedicated Conditional
Access MFA authentication context. Sensitive actions additionally require a
distinct step-up authentication context and `auth_time` no more than five
minutes old. Missing, stale, or contradictory evidence fails closed with a
claims-challenge response. The live Conditional Access policies behind both
context IDs must require phishing-resistant MFA and app assignment to the
allowlisted users.

Project Krypto no longer issues an admin cookie and has no application password
fallback. Container Apps owns nonce validation, token refresh, and a fixed
eight-hour platform session. The application additionally rejects tokens older
than one hour, authentication older than eight hours, and tokens issued before
the reviewed `ADMIN_AUTH_NOT_BEFORE` cutoff. Allowlist/app-role removal and that
cutoff provide application-side revocation/versioning; Entra and Container Apps
own provider-session revocation and key rotation.

Every protected mutation appends a redacted `OperatorAuditEvent` containing the
stable object/subject IDs, reviewed operator label and role, authentication
method/context/MFA evidence, hashed platform session ID, policy version,
request/release/deployment correlation, and UTC times. The table is append-only
by trigger and grants runtime only `SELECT, INSERT`. Access tokens, raw
principals, email addresses, cookies, and secrets are never persisted. Safety
incidents retain the same request/release/deployment correlation and stable
operator ID.

There is no password break-glass path. Emergency administration, if enabled,
uses two predeclared Entra emergency accounts with separate custodians,
phishing-resistant MFA, independent alerting, and a time-bound app-role
assignment of at most 30 minutes. One custodian requests activation and the
other approves it; neither account is routinely assigned. Every use opens a
credential concern incident, records Entra/PIM and Project Krypto operator
evidence, removes the assignment, advances the revocation cutoff, verifies
disabled/manual state, and receives post-use release/security review. A future
password path would require a new ADR, a distributed atomic PostgreSQL limiter,
platform-verified client identity, bounded retention, fail-closed storage,
rotation/versioning, two-custodian material, and independent alerts. It must
never be a fallback from Entra.

## Consequences

- Shared passwords, spoofable client IPs, per-replica login counters, app HMAC
  keys, and 24-hour app sessions are removed from routine administration.
- A live Entra app registration, secret, app roles, operator assignments,
  authentication-context policies, and sign-in/incident alerts are deployment
  prerequisites; source completion is not live proof.
- Target smoke can prove anonymous, spoofed-header, password-only, redirect, and
  security-header behavior without impersonating a human. The normal MFA flow,
  stale/revoked session checks, and two-custodian emergency drill remain attended
  evidence indexed in issue #76.
- Public and scheduler routes remain independent. Cron authentication is not
  weakened or replaced by user identity.
- Production remains disabled/manual and v2 remains paper-only.

## Alternatives considered

- **Harden the shared password and cookie** — rejected because even a distributed
  limiter and rotated HMAC key cannot provide immutable named identity or Entra
  Conditional Access evidence.
- **Validate raw JWTs in Next.js** — rejected because it duplicates platform
  key/discovery/session handling and would expose provider tokens to more code.
- **Require authentication globally at ingress** — rejected because it would
  intercept public, probe, and machine-authenticated routes.
- **Trust arbitrary forwarded identity/IP headers** — rejected because only the
  documented platform-injected principal headers are within the Container Apps
  trust boundary.
