# 0009 — Foundry prompt agents as a read-only decision boundary

- **Status:** Accepted
- **Date:** 2026-08-15
- **Deciders:** @VeVarunSharma

## Context

Project Krypto previously called environment-specific Azure OpenAI v1 model
deployments directly. The application already contains the critical
orchestration: market and account collection, deterministic policy, strict
decision parsing, lease/mutex handling, authorization, journaling, and paper
execution. The deployment task requires real Microsoft Foundry Agents without
moving those safety controls into a model-controlled runtime.

Foundry supports prompt agents and hosted agents. A hosted agent would duplicate
the TypeScript orchestration in another compute boundary, add an agent identity
and container lifecycle, and create a larger place for execution capability to
drift. One shared agent would also weaken explicit dev/prod isolation.

## Decision

Use one **toolless prompt agent per environment**, each in its own Foundry
project:

- dev: `krypto-dev-agents` / `krypto-dev-decision` /
  `krypto-dev-luna`;
- prod: `krypto-prod-agents` / `krypto-prod-decision` /
  `krypto-prod-luna`.

The prompt agent returns only the existing strict `HOLD | BUY | SELL` decision
schema. It has no tools and cannot execute, record, authorize, or schedule a
trade. The application pins every invocation to an immutable agent version,
verifies the response binding, parses the full domain schema locally, and then
runs the unchanged deterministic authorization and paper-execution path.

Runtime and ops identities receive only the project-scoped custom
**Project Krypto Foundry Agent Invoker**. Live managed-identity proof established
that version-pinned prompt invocation requires exactly agent read/write,
Responses read/write, and endpoint interaction. The role grants no Actions,
delete, state, key, or infrastructure permissions. The project managed
identities and attended deployer receive **Foundry User** only at the matching
project scope. Direct-model diagnostics remain a platform-operator concern, not
an application runtime capability.

The compatibility cutover is ordered: deploy and smoke agents, release the
agent-integrated application, pass post-invocation no-trade database checks,
then remove legacy account-scoped `Cognitive Services OpenAI User`. Removing
that role before the application release would break the currently deployed
pre-agent dev image, so the role may exist only as a documented temporary
migration dependency.

## Consequences

- Positive: Microsoft Foundry owns real, versioned Agent resources while
  deterministic authorization and execution remain outside model control.
- Positive: Dev/prod project, agent, model, version, and invoker RBAC bindings
  are explicit and independently testable.
- Positive: The remote agent cannot call tools or application services.
- Positive: Binding drift becomes a typed, journaled, alerted guardrail event.
- Trade-off: Prompt instructions and TypeScript input construction are separate
  reviewed sources and must remain schema-compatible.
- Trade-off: Every agent version update requires a reviewed parameter-source
  change and an application release before legacy direct-model access can be
  removed.
- Trade-off: Foundry's message-creation path requires `agents/write`; a custom
  role is necessary to grant it without broader Foundry User or unrelated
  delete/state/key permissions.
- Follow-up: Complete the reviewed application image rollout when GitHub Actions
  billing permits or through the equivalent retained local release procedure,
  then delete the four legacy account-scoped inference roles.

## Alternatives considered

- **Hosted agent containing the orchestration:** rejected because it duplicates
  safety-critical code and expands the remote execution boundary.
- **One shared prompt agent:** rejected because model deployment and RBAC
  isolation would be implicit rather than environment-specific.
- **Keep direct model inference only:** rejected because it does not stand up a
  real Foundry Agent resource.
- **Give the prompt agent trading tools:** rejected because model-controlled
  actions cannot satisfy the deterministic authorization boundary.
