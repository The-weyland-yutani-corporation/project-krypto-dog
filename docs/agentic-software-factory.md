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
6. Implementation agents open draft PRs.
7. Code review runs automatically; QA, security, docs-sync, and trading-safety run by label or high-risk path.
8. Docs/spec sync keeps repository knowledge aligned.
9. Release readiness checks prepare operator handoff.
10. Governance reports track cost, outcomes, and noisy automation.

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
| `ready-for-ai-dev` | Implementation agent may open a draft PR |
| `needs-ai-review` | PR needs automated review |
| `needs-qa` | QA/test-plan review requested |
| `security-review` | Security review required |
| `trading-safety` | Trading-safety review required |
| `docs-sync` | Documentation/spec alignment required |
| `release-readiness` | Release manager review required |
| `ready-for-human-review` | Human review gate |

## Human gates

Automation may create issues, comments, labels, and draft PRs. Humans retain control over:

- merging PRs
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
| `/implement` | Ask an implementation agent to open a draft PR |
| `/release-readiness` | Produce a release readiness checklist |

QA and docs-sync are label-triggered with `needs-qa` and `docs-sync` so routine PRs do not fan out into expensive review loops.

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
- Changes to trading, guardrails, auth, secrets, workflows, database state, or deployment procedure require extra review.
- CODEOWNERS marks high-risk surfaces for owner review when branch protection enforces it.
- Opportunity discovery creates software tickets and experiments behind rubber-duck review; it does not provide trading advice, execute trades, or bypass safety review.
