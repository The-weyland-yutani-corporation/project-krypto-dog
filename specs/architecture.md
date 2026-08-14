# Deployment architecture and service map

> **State snapshot: 2026-08-14 — FOUNDATIONS PROVISIONED; RELEASES BLOCKED.**
> Bootstrap, the Foundry account, workload-access bindings, and both
> environment foundations are live. No Luna model deployment, release,
> Container App, job, schedule, or public Azure application URL exists.

This document is the concise source of truth for current deployment state,
the approved Azure topology, planned resource names, and safe operator entry
points. Operational order lives in [`deployment.md`](./deployment.md);
template and identity detail lives in
[`../infra/README.md`](../infra/README.md); release gates live in
[`readiness.md`](./readiness.md).

## Deployment state

| Surface | Current state | Status |
|---|---|---|
| Azure subscription | Runtime selection is **Visual Studio Enterprise Subscription**. Required providers are registered; bootstrap created the three resource groups and four GitHub OIDC identities. Its subscription ID and internal identifiers remain unpublished. | **Bootstrap complete** |
| Region | `westus3` hosts `rg-krypto-platform`, `rg-krypto-dev`, and `rg-krypto-prod`. | **Provisioned** |
| Platform | `ai-krypto-westus3` exists; local auth is disabled and its `CanNotDelete` lock is verified. | [Account live; platform run later failed](https://github.com/VeVarunSharma/project-krypto-dog/actions/runs/31839812884) |
| Model | Exact catalog/quota validation passed for OpenAI `gpt-5.6-luna` `2026-07-09`, `GlobalStandard`, capacity 10 each. Both deployments are absent because Azure returned `715-123420` (“unusual activity”). Support API ticket creation failed for lack of an eligible support plan; portal/account support action is required. | **Blocked** |
| Azure dev | Foundation resources and runtime/scheduler/ops identities exist; runtime/ops have Cognitive Services OpenAI User. No release/app/jobs exist. | [Foundation passed](https://github.com/VeVarunSharma/project-krypto-dog/actions/runs/31841581875) |
| Azure prod | Foundation resources and runtime/scheduler/ops identities exist; runtime/ops have Cognitive Services OpenAI User. No release/app/jobs exist; no promotion workflow is shipped or approved. | [Foundation passed](https://github.com/VeVarunSharma/project-krypto-dog/actions/runs/31841960745) |
| Email | Dev and prod ACS Email resources and Azure-managed domains exist as foundation resources. No runtime delivery smoke has run. | **Foundation provisioned** |
| Analytics | Prod PostHog key is staged; a separate dev project key is missing. | **Dev blocked; ingestion unverified** |
| Azure evidence | Live platform/foundation workflow runs exist. No ops-job report, backup, target smoke, activation check, or scheduled execution exists because no release is deployed. | **Foundation evidence only** |
| Historical host | An older Vercel build and a fresh Supabase PostgreSQL replacement were observed previously. Neither is the Azure release candidate. | Historical baseline only |
| Scheduling | No Container Apps Jobs or approved production schedule exist. | **No release** |

GitHub Environments, branch restrictions, and protected values are configured
except for the separate dev PostHog key. Required-reviewer rules are unsupported
by the private repository's billing plan, so mutation workflows remain
manual/paused behind configured branch, exact-SHA, and CI gates.

Describe the bootstrap/account/foundations as provisioned, but do not describe
either application release as deployed until target-smoke evidence passes and
this map is updated.

## Target Azure topology

```mermaid
flowchart TB
  GH["GitHub Actions<br/>Environments + OIDC<br/>manual/paused mutation"]

  subgraph PLATFORM["rg-krypto-platform · westus3 · provisioned"]
    ACCOUNT["Foundry account · LIVE<br/>ai-krypto-westus3<br/>local auth disabled + delete lock"]
    DEV_MODEL["krypto-dev-luna<br/>NOT DEPLOYED · blocked 715-123420"]
    PROD_MODEL["krypto-prod-luna<br/>NOT DEPLOYED · blocked 715-123420"]
    ACCOUNT --> DEV_MODEL
    ACCOUNT --> PROD_MODEL
  end

  subgraph DEV["rg-krypto-dev · foundation provisioned"]
    DEV_ACR["Dev ACR · LIVE"]
    DEV_APP["ca-dev-web · NOT DEPLOYED"]
    DEV_JOBS["Container Apps Jobs<br/>NOT DEPLOYED"]
    DEV_PG["PostgreSQL 17 · LIVE<br/>private VNet"]
    DEV_KV["Key Vault · LIVE"]
    DEV_ACS["ACS Email · LIVE<br/>Azure-managed domain"]
    DEV_LOGS["Log Analytics + alerts · LIVE"]
    DEV_EVIDENCE["Evidence storage · LIVE"]
  end

  subgraph PROD["rg-krypto-prod · foundation provisioned"]
    PROD_ACR["Prod ACR · LIVE"]
    PROD_APP["ca-prod-web · NOT DEPLOYED"]
    PROD_JOBS["Container Apps Jobs<br/>NOT DEPLOYED"]
    PROD_PG["PostgreSQL 17 · LIVE<br/>private VNet"]
    PROD_KV["Key Vault · LIVE"]
    PROD_ACS["ACS Email · LIVE<br/>Azure-managed domain"]
    PROD_LOGS["Log Analytics + alerts · LIVE"]
    PROD_EVIDENCE["Evidence storage · LIVE"]
  end

  GH -->|"platform account/model/access workflows"| PLATFORM
  GH -->|"dev deploy identity"| DEV
  GH -->|"prod deploy + forced-disable identities"| PROD
  DEV_ACR --> DEV_APP
  DEV_ACR --> DEV_JOBS
  DEV_APP --> DEV_PG
  DEV_APP --> DEV_KV
  DEV_APP --> DEV_ACS
  DEV_JOBS --> DEV_EVIDENCE
  DEV_APP --> DEV_MODEL
  PROD_ACR --> PROD_APP
  PROD_ACR --> PROD_JOBS
  PROD_APP --> PROD_PG
  PROD_APP --> PROD_KV
  PROD_APP --> PROD_ACS
  PROD_JOBS --> PROD_EVIDENCE
  PROD_APP --> PROD_MODEL
```

Runtime and ops user-assigned managed identities authenticate to Foundry
through Microsoft Entra ID. Each receives exactly **Cognitive Services
OpenAI User** at the account scope. Scheduler identities call the app and
receive no direct model role. Foundry local authentication/API keys are
disabled.

### Deployment identity security boundary

Every mutation permission stays at the identity's assigned resource-group
scope:

| Identity | Resource-group roles | Subscription read-only roles |
|---|---|---|
| Platform | `rg-krypto-platform`: Contributor, Role Based Access Control Administrator, Locks Contributor | Project Krypto Provider Registration Reader; Cognitive Services Usages Reader |
| Dev deploy | `rg-krypto-dev`: Contributor, Role Based Access Control Administrator | Project Krypto Provider Registration Reader |
| Prod deploy | `rg-krypto-prod`: Contributor, Role Based Access Control Administrator, Locks Contributor | Project Krypto Provider Registration Reader |
| Prod forced-disable | `rg-krypto-prod`: Contributor | none |

**Project Krypto Provider Registration Reader** is a minimal custom
subscription role containing only
`Microsoft.Resources/subscriptions/providers/read`. It lets the platform, dev,
and prod-deploy workflows run provider `--check-only` without broad Reader or
provider-registration permission. The platform identity additionally reads
live quota through **Cognitive Services Usages Reader**. Prod deploy's
RG-scoped Locks Contributor manages the PostgreSQL, Key Vault, and evidence
storage locks; platform's manages the Foundry account lock.

An authorized subscription owner must run
`.github/scripts/azure/register-providers.sh` before bootstrap. Its required
provider set includes `Microsoft.Network`; workflows only inspect registration
after bootstrap.

## Approved platform contract

| Setting | Approved value |
|---|---|
| Resource group | `rg-krypto-platform` |
| Foundry account | `ai-krypto-westus3` |
| Region | `westus3` |
| Publisher/model/version | OpenAI `gpt-5.6-luna` `2026-07-09` |
| SKU | `GlobalStandard` |
| Dev deployment | `krypto-dev-luna`, capacity 10 |
| Prod deployment | `krypto-prod-luna`, capacity 10 |
| Upgrade policy | `NoAutoUpgrade` |
| Runtime API | Azure OpenAI v1 base URL ending `/openai/v1` |
| Runtime auth | User-assigned managed identity selected by `AZURE_CLIENT_ID` |

`azure-platform.yml` verifies one exact catalog mapping and the desired
aggregate capacity (10 + 10 = 20) against the matching live quota dimension.
It passes both target deployment-name/capacity pairs and subtracts only exact
existing target capacity on the same format/model/version/SKU dimension,
making exact reruns idempotent without crediting unrelated capacity. It has
separate environment-scoped what-if/apply jobs for the account and model
deployments. `azure-platform-access.yml` has its own pair for workload role
bindings. They are currently manual/paused; no required-reviewer enforcement is
available on this repository plan.

## Resource map and live state

Names below are either live foundation resources or planned release resources.

| Resource | Platform/shared | Dev | Prod | Live state |
|---|---|---|---|---|
| Resource group | `rg-krypto-platform` | `rg-krypto-dev` | `rg-krypto-prod` | All live |
| Foundry account | `ai-krypto-westus3` | — | — | Live; local auth disabled; lock verified |
| Model deployment | — | `krypto-dev-luna` | `krypto-prod-luna` | Not deployed; blocked |
| VNet | — | `vnet-krypto-dev` | `vnet-krypto-prod` | Both live |
| Container Apps environment | — | `cae-krypto-dev` | `cae-krypto-prod` | Both live |
| Web app | — | `ca-dev-web` | `ca-prod-web` | Not deployed |
| PostgreSQL server | — | `psql-krypto-dev` | `psql-krypto-prod` | Both live; private PostgreSQL 17 |
| ACR | — | `acrkryptodev` | `acrkryptoprod` | Both live |
| Key Vault | — | `kv-krypto-dev` | `kv-krypto-prod` | Both live |
| Evidence storage | — | `stkryptodevevid` | `stkryptoprodevid` | Both live |
| Communication Service | — | `acs-krypto-dev` | `acs-krypto-prod` | Both live |
| Email Communication Service | — | `email-krypto-dev` | `email-krypto-prod` | Both live with managed domains |
| Hourly job | — | `caj-dev-agent-run` | `caj-prod-agent-run` | Not deployed |
| Daily job | — | `caj-dev-daily-summary` | `caj-prod-daily-summary` | Not deployed |
| Ops jobs | — | `caj-dev-{migrate-init,preflight,verified-backup,target-smoke,activation-check}` | `caj-prod-{migrate-init,preflight,verified-backup,target-smoke,activation-check}` | Not deployed |

Separate PostHog projects remain required. The prod key is staged as an
environment secret; the separate dev key is missing.

## Provisioning and release flow

```mermaid
flowchart TD
  PROVIDERS["COMPLETE<br/>required providers registered"]
  BOOT["COMPLETE<br/>resource groups + OIDC identities"]
  PLATFORM["PARTIAL<br/>account live; model blocked"]
  DEV_FOUNDATION["COMPLETE<br/>dev foundation"]
  PROD_FOUNDATION["COMPLETE<br/>prod foundation"]
  ACCESS["COMPLETE<br/>four OpenAI User bindings"]
  DEV_FULL["BLOCKED<br/>dev full release"]
  DEV_MANUAL["PENDING<br/>manual shadow + activation proof"]
  DEV_SCHEDULE["PENDING<br/>activate monitored Schedule"]
  DEV_OBSERVE["PENDING<br/>observe scheduled success"]
  PROD_FULL["NOT STARTED<br/>prod disabled/manual release"]

  PROVIDERS --> BOOT
  BOOT --> PLATFORM
  BOOT --> DEV_FOUNDATION
  BOOT --> PROD_FOUNDATION
  DEV_FOUNDATION --> ACCESS
  PROD_FOUNDATION --> ACCESS
  ACCESS --> DEV_FULL --> DEV_MANUAL --> DEV_SCHEDULE --> DEV_OBSERVE
  ACCESS --> PROD_FULL
```

Both foundations and all four `azure-platform-access.yml` bindings now exist.
Full release remains blocked by the absent Luna deployments and missing
separate dev PostHog key; bypassing those gates is not approved.

Dev schedule activation deploys and validates `schedule-monitoring.bicep` with
the current activation timestamp before `rollout.bicep` may set either job to
`Schedule`. Disable, rollback, and rotation paths first make and verify both
jobs `Manual`, then disable monitoring at boundary `0`.
The same generation plus the exact image digest namespaces hourly scheduled
idempotency, so an old same-hour run cannot satisfy current observation;
run-flow rejects cross-mode replay of an existing key.

Prod deployment and secret rotation share the
`azure-production-mutation` concurrency lock and end disabled/manual. No
executable production promotion workflow is shipped or approved. The
`production-promotion` identity/environment is retained only for the
forced-disable portions of those two workflows; any future promotion requires
a new evidence-bound design and review.

## Database and provider boundaries

- `DATABASE_URL` uses least-privilege `krypto_app`; `DIRECT_URL` uses
  `krypto_owner`. Both address the same private PostgreSQL 17 server/database
  with `sslmode=require`.
- GitHub-hosted runners do not connect to PostgreSQL. VNet-integrated ops jobs
  perform migration, preflight, and backup work.
- ACS connection strings are generated by Azure from the environment's
  Communication Service and written directly to Key Vault. They never transit
  GitHub.
- The runtime receives `AZURE_COMMUNICATION_CONNECTION_STRING`,
  `AZURE_COMMUNICATION_EMAIL_SENDER`, and `ALERT_EMAIL_TO`.
- Foundry runtime configuration is `AZURE_OPENAI_BASE_URL`,
  `AZURE_OPENAI_DEPLOYMENT_NAME`, and `AZURE_CLIENT_ID`; there is no model API
  key.

## Live endpoint register

No URL is recorded until the matching deployment and retained target-smoke
evidence pass.

| Environment | App | Resource group | Public URL | Status |
|---|---|---|---|---|
| Azure dev | `ca-dev-web` (not created) | `rg-krypto-dev` (foundation live) | No URL | **Foundation deployed; release blocked** |
| Azure prod | `ca-prod-web` (not created) | `rg-krypto-prod` (foundation live) | No URL | **Foundation deployed; no release or promotion workflow** |

Do not publish subscription IDs, full Azure resource IDs, PostgreSQL FQDNs,
Key Vault URLs, evidence-container URLs, identity IDs, or other protected
deployment outputs.

## Operator links

| Service | Entry point | Purpose |
|---|---|---|
| GitHub Actions | [Workflow runs](https://github.com/VeVarunSharma/project-krypto-dog/actions) | Platform, access, foundation, release, and evidence runs |
| GitHub Environments | [Environment settings](https://github.com/VeVarunSharma/project-krypto-dog/settings/environments) | Configured environment values and branch restrictions; required reviewers are unavailable on the current plan, so mutation remains manual/paused |
| Azure | [Azure portal](https://portal.azure.com/) | Select **Visual Studio Enterprise Subscription**, then the existing platform/dev/prod resource groups; do not publish internal URLs or IDs |
| Microsoft Foundry | [Foundry portal](https://ai.azure.com/) | Inspect the live `ai-krypto-westus3` account and resolve the blocked model deployment through portal/account support |
| PostHog | [PostHog US](https://us.posthog.com/) | Prod is staged; create and stage a distinct dev project key |

## Source-of-truth links

- [`deployment.md`](./deployment.md) — ordered operator runbook.
- [`../infra/README.md`](../infra/README.md) — Bicep, identity, secret, and
  monitoring detail.
- [`readiness.md`](./readiness.md) — evidence and release gates.
- [`monitoring.md`](./monitoring.md) — signals and alert behavior.
- [`decisions/0008-azure-native-deployment-architecture.md`](./decisions/0008-azure-native-deployment-architecture.md)
  — accepted Azure architecture decision.
