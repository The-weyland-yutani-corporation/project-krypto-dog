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
9. A deterministic merge policy allows autonomous merge only for allowlisted low-risk docs/assets; all other paths require current human approval.
10. QA, security, docs-sync, and trading-safety run by label or high-risk path.
11. Release readiness and governance workflows prepare operator handoff and track factory health.

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

## Human gates

Automation may create issues, comments, labels, and PRs. Allowlisted low-risk agent PRs may merge automatically after every required check passes. Humans retain control over:

- merging all code, test, config, migration, trading, auth, database, deployment, workflow, operator-console, and policy changes
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
- zero unconditional approving reviews, because `Agentic merge policy` conditionally requires a current-head human approval for every non-low-risk change
- required conversation resolution and admin enforcement enabled
- force pushes and protected-branch deletion disabled
- default Actions workflow permissions set to read

## Validation baseline

Implementation and QA workflows should use existing commands only:

```bash
npm run lint
npm run typecheck:scripts
npm run build
npm test -- --ci
```

## Safety invariants

- v2 remains paper trading only.
- Live execution requires a separate RFC, architecture review, security review, trading-safety review, and human approval.
- Changes to trading, guardrails, auth, secrets, workflows, tests, database state, deployment procedure, or operator behavior require current human approval.
- The required `Agentic merge policy` status enforces the low-risk allowlist independently of agent output and labels.
- Self-heal is limited to two repair commits and structurally restricted to the same non-sensitive documentation scope eligible for autonomous merge.
- Opportunity discovery creates software tickets and experiments behind rubber-duck review; it does not provide trading advice, execute trades, or bypass safety review.
