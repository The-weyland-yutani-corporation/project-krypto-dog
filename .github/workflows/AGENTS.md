# `.github/workflows` — agentic workflows (GH-AW)

Scoped delta to root [`AGENTS.md`](../../AGENTS.md). Read the root safety kernel
first.

## Mission

Author, debug, and upgrade GitHub Agentic Workflows (`*.md` + generated
`*.lock.yml`). The canonical how-to is the skill at
[`../skills/agentic-workflows/SKILL.md`](../skills/agentic-workflows/SKILL.md);
the thin entry point is [`../agents/agentic-workflows.md`](../agents/agentic-workflows.md).

## Non-negotiables (delta)

- Every workflow `.md` must be compiled to its `.lock.yml` with
  `gh aw compile`; never hand-edit generated lock files.
- Least privilege: minimal `permissions`, explicit `network.allowed`
  (ecosystem IDs or FQDNs — not `npm`/`pypi` shorthands), no template injection.
- Use **safe outputs** for any GitHub write; do not grant broad write scopes.
- Reconciler and merge-policy implementation changes may be agent-authored, but
  they are `risk:boundary`: never auto-repaired or auto-merged, and gated by a
  current-head authorized repository administrator's explicit merge.
- Do not change merge/authority semantics in
  [`../agentic-policy.json`](../agentic-policy.json), handle secrets/external
  accounts, or perform another human-only action from the root map.
- Dependabot PRs against generated manifests are fixed at source `.md` +
  `gh aw compile --dependabot`, never merged directly.

## Validation

- `gh aw compile [workflow]` and `gh aw compile --validate`.
- `npm run test:agentic-sdlc` for workflow/reconciler contracts.

## Escalation / non-goals

- Changes here route to **security review** (`.github/**` in
  `specialistRouting.security`).
- Escalate only for the human-only authority decisions in the root map or when a
  requested change would weaken the safety kernel. Boundary implementation work
  proceeds through the machine checks and final human boundary gate above.
