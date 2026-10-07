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

## Loops within the factory

The factory is not one unbounded agent loop. It is four nested, durable loops
with different triggers, state owners, budgets, and stop conditions.

```mermaid
flowchart LR
  Human["Authorized administrator"]
  Pause["Factory control<br/><code>active | shadow | paused</code>"]
  Goal["Approved factory goal<br/>scope + max WIP + assignment budget + max risk"]

  subgraph Outer["OUTER LOOP - Observe, govern, and improve the factory"]
    direction LR
    RuntimeEvidence["Runtime and factory evidence<br/>Azure telemetry, PR throughput,<br/>blocked work, cost, safe outputs"]
    Monitor["MonitorOps<br/><code>daily-repo-status</code><br/><code>agentic-governance</code>"]
    Learn["Learning reports<br/><code>agentic-corrections</code><br/><code>harness-entropy</code>"]
    Opportunities["Opportunity backlog<br/><code>opportunity-discovery</code><br/>maximum one issue per run"]
    Triage["Product triage<br/><code>pm-triage</code>"]
    RuntimeEvidence -->|"daily / weekly schedules"| Monitor
    RuntimeEvidence -->|"weekly schedules"| Learn
    Monitor -->|"durable status or governance issue"| Opportunities
    Learn -->|"measured gaps; no direct policy mutation"| Opportunities
    Opportunities -->|"issue opened or labeled"| Triage
  end

  subgraph Mission["MISSION LOOP - Turn one approved goal into bounded work"]
    direction LR
    Plan["Plan and decompose<br/><code>em-planning</code> on<br/><code>ready-for-planning</code>"]
    Ready["Eligible leaf issue<br/><code>ready-for-ai-dev</code><br/>closed dependencies + allowed paths"]
    Queue["Deterministic queue controller<br/>goal, WIP, budget, risk, mode"]
    Claim["Owned expiring claim<br/><code>factory:claimed</code>"]
    Implement["Implementation dispatch<br/><code>implement-ticket</code>"]
    Coding["Copilot coding agent<br/>one claimed issue"]
    Triage -->|"ready-for-planning"| Plan
    Plan -->|"acceptance criteria + test plan"| Ready
    Goal --> Queue
    Ready --> Queue
    Queue -->|"one eligible issue"| Claim --> Implement --> Coding
  end

  subgraph Inner["INNER DELIVERY LOOP - Prove or repair one pull-request head"]
    direction LR
    PR["Implementation PR<br/><code>factory:pr-open</code>"]
    Review["Exact-head checks<br/>CI + migrations + code review<br/>conditional QA, security, trading safety"]
    Policy{"Lifecycle policy<br/>provenance, scope, risk,<br/>human veto, current SHA"}
    Repair["Capped self-heal<br/><code>pr-self-heal</code><br/><code>factory:repairing</code>"]
    Merge["Native auto-merge<br/>routine/sensitive only"]
    Boundary["Administrator merge<br/>boundary or fork only"]
    Block["Blocked or paused<br/>unsafe, stale, ambiguous,<br/>scope drift, cap exhausted"]
    Coding --> PR -->|"opened / synchronize / labels"| Review --> Policy
    Policy -->|"repairable failure"| Repair -->|"new head"| Review
    Policy -->|"all required checks pass"| Merge
    Policy -->|"boundary or fork + trusted approval"| Boundary
    Policy -->|"veto or invariant failure"| Block
  end

  subgraph Runtime["EVIDENCE LOOP - Deploy the merge and feed observations back"]
    direction LR
    Merged["Merged exact SHA"]
    DevDeploy["Exact-SHA development deploy<br/>GitHub OIDC + immutable digest"]
    ShadowRun["Azure Container Apps<br/><code>shadow</code> scheduled/manual runs"]
    Observe["Evidence storage, PostgreSQL journals,<br/>Log Analytics alerts, release evidence"]
    Done["Lifecycle reconciliation<br/><code>factory:deployed-dev</code><br/><code>factory:done</code>"]
    Merge --> Merged
    Boundary --> Merged
    Merged --> DevDeploy --> ShadowRun --> Observe --> Done
    Observe --> RuntimeEvidence
  end

  Human -. "sets mode; automation cannot activate itself" .-> Pause
  Pause --> Queue
  Human -. "approves or renews goal" .-> Goal
  Triage -. "candidate work must fit approved direction" .-> Goal
  Done -. "remaining eligible leaves continue while budget remains" .-> Queue
  Block -. "durable evidence returns to governance" .-> RuntimeEvidence
  Goal -. "exhausted budget, risk ceiling, or WIP stops mission" .-> Block

  Prod["PRODUCTION / LIVE BOUNDARY<br/>manual, disabled, separately approved"]
  ShadowRun -. "no autonomous promotion" .-> Prod

  classDef outer fill:#172033,stroke:#a78bfa,color:#f8fafc,stroke-width:2px;
  classDef mission fill:#082f49,stroke:#38bdf8,color:#f8fafc,stroke-width:2px;
  classDef inner fill:#052e16,stroke:#22c55e,color:#f8fafc,stroke-width:2px;
  classDef evidence fill:#111827,stroke:#50e6ff,color:#f8fafc,stroke-width:2px;
  classDef authority fill:#fff4ce,stroke:#ffb900,color:#242424,stroke-width:2px;
  classDef stop fill:#450a0a,stroke:#ef4444,color:#f8fafc,stroke-width:2px;

  class RuntimeEvidence,Monitor,Learn,Opportunities,Triage outer;
  class Plan,Ready,Queue,Claim,Implement,Coding mission;
  class PR,Review,Policy,Repair,Merge,Boundary inner;
  class Merged,DevDeploy,ShadowRun,Observe,Done evidence;
  class Human,Pause,Goal authority;
  class Block,Prod stop;
```

| Loop | Primary triggers | Durable state | Exit or stop condition |
|---|---|---|---|
| **Outer governance loop** | daily/weekly schedules, runtime evidence, factory events | recurring report issues, opportunity issues, measured correction/entropy evidence | no approved goal, opportunity WIP cap, or a finding that requires human direction |
| **Mission loop** | approved goal plus `ready-for-planning` / `ready-for-ai-dev` labels | issue graph, lifecycle/risk labels, dependencies, allowed paths, owned lease | goal WIP/budget/risk exhausted, no eligible leaf, paused/shadow mode, or ambiguous scope |
| **Inner delivery loop** | PR `opened`, `synchronize`, `reopened`, and specialist labels | current PR head, checks, reviews, repair count, human veto | merge evidence passes, repair cap is exhausted, boundary approval is absent, or an invariant fails |
| **Evidence loop** | exact merged SHA | immutable image digest, dev deployment, journals, alerts, release evidence, lifecycle labels | dev/shadow proof completes or failure returns durable evidence to the outer loop |

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
