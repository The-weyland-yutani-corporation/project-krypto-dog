---
description: Auto-merge-enabled implementation workflow for ready tickets.
on:
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number or task description
        required: false
        type: string
  slash_command:
    name: implement
    events: [issues, issue_comment]
    strategy: centralized
  issues:
    types: [labeled]
    names: [ready-for-ai-dev]
permissions:
  contents: read
  issues: read
  pull-requests: read
  checks: read
  actions: read
  copilot-requests: write
imports:
  - .github/agents/project-krypto-dev.md
env:
  AZURE_OPENAI_ENDPOINT: https://stub.openai.azure.com
  AZURE_OPENAI_API_KEY: stub
  AZURE_OPENAI_DEPLOYMENT_NAME: claude-sonnet-stub
  CDP_API_KEY_NAME: stub
  CDP_API_KEY_PRIVATE_KEY: stub
  DATABASE_URL: postgresql://stub:stub@localhost:5432/stub
  POSTHOG_API_KEY: phc_stub
  CRON_SECRET: stub
  ADMIN_PASSWORD: stub
  ADMIN_SESSION_SECRET: stub
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
  bash:
    - npm ci
    - npm run lint
    - npm run typecheck:scripts
    - npm run build
    - npm test -- --ci
network:
  allowed: [defaults, node]
safe-outputs:
  create-pull-request:
    title-prefix: "[ai-dev] "
    labels: [agentic-factory, needs-ai-review, agentic-automerge]
    draft: false
    auto-merge: true
    max: 1
    allowed-files:
      - "src/**"
      - "tests/**"
      - "scripts/**"
      - "drizzle/**"
      - "supabase/migrations/**"
      - "specs/**"
      - "DESIGN.md"
      - "components.json"
      - "package.json"
      - "package-lock.json"
      - "tsconfig*.json"
      - "jest.config.*"
      - "next.config.*"
    protected-files: fallback-to-issue
  create-issue:
    title-prefix: "[ai-dev-blocked] "
    labels: [agentic-factory, blocked]
    max: 1
  add-comment:
    max: 1
  noop:
    report-as-issue: false
max-ai-credits: 2500
max-daily-ai-credits: 5000
timeout-minutes: 30
---

# Implement Ticket

Implement a ready issue and open an auto-merge-enabled PR.

## Task

- Read the target issue, comments, labels, and relevant repository files.
- Confirm the issue is implementation-ready. If not, use `noop` or create a blocked issue with the missing requirements.
- Make the smallest complete code/doc/test changes needed.
- Preserve paper-trading boundaries and guardrails.
- For frontend/admin/chart work, read `DESIGN.md` and use shadcn/ui + Tailwind. Use EvilCharts-inspired Recharts components for charts/graphs.
- If the task unexpectedly requires dependency, README, workflow, agent, or skill changes outside the requested scope, create a blocked/follow-up issue instead of expanding silently.
- Run the narrowest relevant validation, escalating to the baseline commands when appropriate.
- Open one PR with a concise description, validation performed, risks, and linked issue.
- Native auto-merge must remain enabled. Required CI, agentic review, conversation resolution, and merge-policy checks decide whether it can merge.
- Never describe a code, test, config, migration, trading, auth, database,
  deployment, workflow, or operator-console change as low risk. The
  deterministic merge policy routes those paths through the applicable
  current-head code, security, and trading-safety checks.

## Safe outputs

- Use `create-pull-request` for code changes.
- Use `create-issue` only when blocked by missing requirements or unsafe scope.
- Use `add-comment` for status or blocked notes on the triggering issue.
- Use `noop` if there is no implementation-ready task.
