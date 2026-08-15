# Project Krypto Foundry decision agents

Project Krypto uses two Microsoft Foundry **prompt agents**:

| Environment | Project | Agent | Model |
|---|---|---|---|
| dev | `krypto-dev-agents` | `krypto-dev-decision` | `krypto-dev-luna` |
| prod | `krypto-prod-agents` | `krypto-prod-decision` | `krypto-prod-luna` |

Prompt agents are the narrowest fit because the remote component only proposes
one structured decision. Project Krypto's TypeScript process still owns market
collection, policy evaluation, mutex/lease enforcement, final authorization,
journaling, and paper execution. The agents have no tools and no application,
database, scheduler, or trading credentials.

## Source contract

- `instructions.md` is the reviewed instruction source.
- `config.ts` pins project, agent, and model-deployment names.
- `.foundry/agent-metadata*.yaml` records the currently deployed manual context.
- `scripts/foundry-agent.ts` creates immutable versions, fetches the persisted
  version back, exactly compares the complete definition (including empty tools
  and strict schema), then invokes that exact version with a no-trade `HOLD`.

Application calls include both agent name and immutable version. A missing or
different response binding is a typed guardrail failure that is sanitized,
journaled, emitted to telemetry, and sent through the existing alert path.

## Local operator deployment

GitHub-hosted jobs are currently blocked by the repository account's Actions
billing state. Use an authenticated local operator and the reviewed Bicep:

1. Run an Azure what-if for `infra/foundry-agents.bicep`; reject deletes.
2. Apply it in the resource group that owns the operational Foundry account.
3. Deploy and smoke each environment:

```bash
npm run foundry:agent -- deploy --environment dev \
  --project-endpoint https://ghcp-foundry-eastus2.services.ai.azure.com/api/projects/krypto-dev-agents

npm run foundry:agent -- deploy --environment prod \
  --project-endpoint https://ghcp-foundry-eastus2.services.ai.azure.com/api/projects/krypto-prod-agents
```

4. Update the matching reviewed release/rollout `.bicepparam` files if the
   attested version changed. Agent versions are nonsecret and intentionally
   source-controlled so version changes require review.
5. Release the application through the existing environment workflow.
6. After target smoke proves the deployed app uses the exact agent version and
   leaves trade state unchanged, remove that environment's legacy account-wide
   `Cognitive Services OpenAI User` assignments. Retain only project-scoped
   `Foundry Agent Consumer`.

Do not remove the legacy role before the application image is migrated: the
currently deployed pre-agent image still calls the model endpoint directly.

The shared operational account also still permits legacy local/model key
authentication. Project Krypto stores no key and the Agent client uses Entra,
but disabling an account-wide auth method could affect another deployment on
that shared host. Treat owner-approved disablement or migration to the dedicated
Entra-only account as a production-promotion blocker, not as an unattended
agent-deploy mutation.

## Evaluation status

The deployment gate is the exact-definition attestation plus remote structured
`HOLD` smoke in both environments. Dev instruction-based generation produced 15
safety cases and a rubric evaluator. The generated dataset was reviewed,
normalized to the deployed `action`/`notionalUSD`/`reasoning` schema, and
registered as dataset version `2.0`; `eval.yaml` and dev metadata reference only
that curated version. Production generation is tracked separately in
`.foundry/agent-metadata.prod.yaml` until its artifacts are verified.
