# Agentic software factory

Project Krypto runs a safety-bounded, event-driven GitHub factory. The normative contract is [`specs/factory.md`](../specs/factory.md); machine policy is [`.github/agentic-policy.json`](../.github/agentic-policy.json).

## End-to-end dark factory

```mermaid
flowchart TB
  Human["Authorized repository administrator"]
  Control["Factory control issue<br/><code>active | shadow | paused</code>"]
  Goal["Human-approved factory goal<br/>scope, WIP, budget, risk ceiling"]

  subgraph GitHub["GitHub control plane"]
    direction TB
    Trigger["Events, schedules, and commands"]
    Mode{"Deterministic mode gate"}
    Shadow["Shadow evaluation only<br/>no dispatch or merge"]
    Stop["Fail closed<br/>no dispatch or merge"]
    Workflows["GitHub Agentic Workflows<br/>read-only agents + safe outputs"]
    Issues[("Issue graph<br/>labels, dependencies, evidence")]
    Queue["Queue controller<br/>eligibility, WIP, budget, risk"]
    Claim["Owned expiring claim"]
    Coding["Copilot coding agent<br/>bounded issue + allowed paths"]
    PullRequest["Same-repository pull request"]
    Checks["Exact-head evidence<br/>CI + migrations + code review<br/>conditional QA, security, trading safety"]
    Decision{"Lifecycle policy<br/>provenance + current SHA + vetoes"}
    Repair["Capped self-heal<br/>same PR and exact head"]
    Block["Block, alert, or pause<br/>unsafe, stale, ambiguous, exhausted"]
    AutoMerge["GitHub native auto-merge<br/>routine or sensitive only"]
    AdminMerge["Explicit administrator merge<br/>boundary or forked work"]
    Merged["Merged commit<br/>immutable exact SHA"]
  end

  subgraph AzureDev["Azure development trust boundary - autonomous shadow only"]
    direction TB
    OIDC["GitHub OIDC federation<br/>Microsoft Entra workload identity"]
    Registry["Azure Container Registry<br/>immutable image digest"]
    Runtime["Azure Container Apps<br/>web app + scheduled/manual jobs<br/><code>shadow</code> rollout mode"]
    Identity["User-assigned managed identities<br/>least-privilege RBAC"]
    KeyVault["Azure Key Vault<br/>secret-scoped access"]
    Database[("Azure Database for PostgreSQL<br/>private network")]
    Foundry["Microsoft Foundry model<br/>structured read-only proposal<br/>no trade tool or model key"]
    Evidence["Evidence storage + Log Analytics<br/>alerts, journals, exact-SHA proof"]
  end

  subgraph Production["Production and live-trading authority boundary"]
    Prod["Production release<br/><code>disabled</code> + manual jobs"]
    Live["Live execution<br/>unimplemented and unauthorized"]
  end

  Human -. "sets mode" .-> Control
  Human -. "approves bounded goal" .-> Goal
  Control --> Mode
  Goal --> Queue
  Trigger --> Mode
  Mode -- "active" --> Workflows
  Mode -- "shadow" --> Shadow
  Mode -- "paused, missing, or ambiguous" --> Stop
  Workflows --> Issues --> Queue --> Claim --> Coding --> PullRequest --> Checks --> Decision
  Checks -- "repairable failure" --> Repair --> PullRequest
  Checks -- "unsafe or stale" --> Block
  Decision -- "routine/sensitive + all checks pass" --> AutoMerge --> Merged
  Decision -- "boundary or fork" --> AdminMerge --> Merged
  Decision -- "veto, scope drift, or exhausted repair" --> Block
  Block -. "durable issue, alert, or pause" .-> Issues

  Merged -->|"exact merged SHA"| OIDC --> Registry --> Runtime
  Runtime --> Identity
  Identity --> KeyVault
  Identity --> Database
  Runtime -->|"Entra-authenticated request"| Foundry
  Foundry -->|"one HOLD / BUY / SELL proposal"| Runtime
  Runtime --> Evidence
  Database --> Evidence
  Evidence -. "telemetry and release evidence" .-> Issues

  Runtime -. "no autonomous promotion" .-> Prod
  Human -. "separate production approval" .-> Prod
  Prod -. "paper/live boundary remains closed" .-> Live

  classDef human fill:#fff4ce,stroke:#8a6d00,color:#242424,stroke-width:2px;
  classDef github fill:#24292f,stroke:#8c959f,color:#ffffff;
  classDef azure fill:#0078d4,stroke:#50e6ff,color:#ffffff;
  classDef safety fill:#fde7e9,stroke:#d13438,color:#5c0011,stroke-width:2px;
  classDef decision fill:#fff4ce,stroke:#ffb900,color:#242424;

  class Human,Goal,AdminMerge human;
  class Trigger,Workflows,Issues,Queue,Claim,Coding,PullRequest,Checks,Repair,AutoMerge,Merged github;
  class OIDC,Registry,Runtime,Identity,KeyVault,Database,Foundry,Evidence azure;
  class Stop,Block,Prod,Live safety;
  class Control,Mode,Decision,Shadow decision;
```

**Diagram conventions:** solid arrows are automated transitions; dashed arrows
are human authority, feedback, or intentionally blocked promotion paths. The
GitHub and Azure subgraphs are separate trust boundaries. Every merge decision
uses current-head evidence, and every Azure deployment is bound to the exact
merged SHA and immutable image digest.

The design follows GitHub and Azure operational guidance:

- use issues, labels, protected checks, and native auto-merge as durable GitHub
  state rather than hidden agent memory;
- keep agents read-only and perform mutations only through permission-scoped
  safe outputs and deterministic controllers;
- use OIDC federation, Entra workload identities, managed identities, and
  least-privilege RBAC instead of long-lived cloud credentials;
- separate control and data planes, development and production boundaries, and
  runtime, scheduler, and operator identities;
- deploy immutable artifacts, keep PostgreSQL private, centralize secrets in
  Key Vault, and send evidence and alerts to durable observability stores;
- fail closed on missing authority, stale evidence, ambiguous risk, human
  vetoes, exhausted repair budgets, or any attempt to cross production/live
  boundaries.

- Humans approve goals, boundary merges, production/live actions, secrets/accounts, and architecture.
- Automation may triage, plan, implement, review, repair within caps, natively auto-merge eligible routine/sensitive PRs, and deploy the exact merged SHA to development/shadow.
- Missing authority, ambiguous risk/scope, stale checks, human veto, exhausted repair, or safety impact fails closed.
- Labels are lifecycle state; claims are owned expiring leases; all merge evidence must match the current head.
- See [`agentic-workflows-map.md`](./agentic-workflows-map.md) for the generated workflow inventory.
