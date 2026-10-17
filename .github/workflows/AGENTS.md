# Workflow implementation

Read root [`AGENTS.md`](../../AGENTS.md) and
[`specs/factory.md`](../../specs/factory.md).

- Author GH-AW `.md` sources and compile their `.lock.yml` files; never edit
  generated locks manually.
- Keep agents read-only and GitHub mutations in safe outputs or trusted
  deterministic controllers with least-privilege permissions.
- Controllers execute trusted default-branch code, never PR-authored code
  with privileged tokens.
- Same-repository workflow/control-plane changes use automated code review,
  QA, and security verification instead of a per-change human gate.
- Preserve exact-head evidence, emergency pause, scoped credentials, bounded
  retries, and explicit error reporting.

Validate with strict GH-AW compilation and `npm run test:agentic-sdlc`.