# Project Krypto deployment recovery

> **Status:** Planning

Not approved for provisioning, access changes, protected-setting replacement,
or live workflow dispatch. Existing Bicep is the selected recipe; this is a
modification/recovery of the Next.js application, not an AZD migration.

## Goal

Recover unattended software delivery through a verified development/shadow
deployment and a separately protected, disabled production release. Keep
real-money trading disabled and preserve the emergency pause,
current-head review, migrations, reconciliation, backup, rollback, and health
evidence requirements.

## Confirmed decisions

- The owner selected the signed-in default Azure subscription as the new target.
- Region: `westus3`.
- The owner selected development and production infrastructure together,
  including their dedicated shared model host. This is implementation scope,
  not production activation or provisioning authorization.
- Azure planning ceiling: $500/month, including application-model use and
  monitoring but excluding existing GitHub/Copilot subscriptions. This is not
  an Azure-enforced spending cap or an authorization to spend.
- Target subscription and tenant bindings are kept in private session state
  and, after separate approval, protected deployment settings. Do not commit
  them or copy old credentials.
- Existing Azure resources and credentials are not to be deleted or migrated
  implicitly.
- The owner approved one factory resume only after blocking repairs and
  readiness checks pass.
- The shared factory model setting was changed from unavailable `gpt-5.4` to
  `gpt-5.3-codex` with explicit owner approval and verified by readback. A
  subsequent hosted PM Triage run
  [completed successfully](https://github.com/The-weyland-yutani-corporation/project-krypto-dog/actions/runs/39540190455)
  with that configured setting. Daily MonitorOps itself still needs a
  successful post-change run.
- Target selection does not authorize provisioning, permission changes,
  production activation, or removal of platform protections.

## Preparation

- [x] Inspect only the selected target for existing Krypto resources.
- [x] Map the existing Bicep and GitHub deployment pipeline to the new target.
- [x] Record region, footprint, cost assumptions, identity effects, and prerequisites.
- [ ] Obtain approval for the bounded provisioning/configuration plan.
- [ ] Validate the approved configuration before deployment.

## Verified preparation evidence

Read-only discovery on 2026-10-21 found no `rg-krypto-*` resource groups in
the selected subscription. All 12 providers required by
`.github/scripts/azure/register-providers.sh` are already registered.

| Capacity | Current / limit | Planned incremental demand |
| --- | --- | --- |
| Container Apps managed environments, westus3 | 2 / 50 | Two environments; projected 4 / 50 |
| Virtual networks, westus3 | 1 / 1000 | Two networks; projected 3 / 1000 |
| Storage accounts, westus3 | 2 / 250 | Two evidence accounts; projected 4 / 250 |
| OpenAI GlobalStandard gpt-5.6-luna, westus3 | 0 / 250 capacity units | Two deployments of 10; projected 20 / 250 |

The regional catalog offers `OpenAI/gpt-5.6-luna/2026-07-09` with
`GlobalStandard`. Account-specific catalog validation and an actual Entra
inference smoke are still required after an approved account creation.
PostgreSQL `Standard_B1ms` and `Standard_D2ds_v5` appear in the regional
capabilities catalog, and the region reports geo-backup support as Enabled.
Those listings are not guarantees of provisioning
admission. Preserve the existing dev 32-GB/Burstable and prod
64-GB/GeneralPurpose sizing, 35-day PITR, and prod geo-redundant backup.

The observed GitHub OIDC subject includes the current organization and
immutable owner/repository IDs. This repair corrects the stale owner in
`infra/params/bootstrap.bicepparam`; the subject construction in
`infra/modules/oidc-identity.bicep` remains unchanged.

The proposed ACR, Key Vault, storage, PostgreSQL, Communication Services,
and Foundry custom-domain names below passed name-availability checks.
They are not reserved or provisioned. No old resources are adopted by name.

| Resource | Development | Production / shared platform |
| --- | --- | --- |
| Resource group | `rg-krypto-dev` | `rg-krypto-prod`; `rg-krypto-platform` |
| Name prefix | `krypto-dev02` | `krypto-prod02` |
| ACR | `acrkryptodev02` | `acrkryptoprod02` |
| Key Vault | `kv-krypto-dev02` | `kv-krypto-prod02` |
| Evidence storage | `stkryptodev02evid` | `stkryptoprod02evid` |
| PostgreSQL | `psql-krypto-dev02` | `psql-krypto-prod02` |
| Communication Services | `acs-krypto-dev02` | `acs-krypto-prod02` |
| Email Services | `email-krypto-dev02` | `email-krypto-prod02` |
| Foundry account / custom domain | Shared | `ai-krypto-westus3-02` |

Inherited policies deploy Advanced Threat Protection for PostgreSQL Flexible
Server. The subscription's `OpenSourceRelationalDatabases` Defender plan is
already Standard. Do not disable that policy or plan to meet the budget;
include its incremental charges in the estimate.

## Cost inputs, not a deployment quote

The Azure Retail Prices API returned these USD consumption meters for
`westus3`:

| Meter | Observed retail rate | Planning calculation |
| --- | --- | --- |
| PostgreSQL Flexible Server B1MS | $0.017/hour | $12.41 per 730-hour month |
| PostgreSQL Flexible Server Standard_D2ds_v5, 2-vCore SKU | $0.178/hour | $129.94 per 730-hour month |
| PostgreSQL Flex Server storage | $0.115/GB/month | $11.04 for 32 + 64 GB |
| PostgreSQL Flexible Server LRS backup storage | $0.095/GB/month | Depends on billable retained backup volume |
| ACR Basic registry | $0.1666/day | Approximately $10.00/month for two registries |
| Container Apps active vCPU | $0.000024/second | $31.54 per continuously active 0.5-vCPU replica/month |
| Container Apps active/idle memory | $0.000003/GiB-second | $7.88 per 1-GiB replica/month |
| GPT-5.6 Luna GlobalStandard short-context input/output | $0.20 / $1.20 per million tokens | Usage-dependent |
| GPT-5.6 Luna GlobalStandard long-context input/output | $0.40 / $1.80 per million tokens | Usage-dependent |

Source: <https://prices.azure.com/api/retail/prices>, retrieved during recovery.
These are public retail meter readings, not a contractual quote. Container
Apps replica resource assignments must be verified from the admitted
configuration; the templates do not explicitly size the web containers.
ACR builds, storage operations, monitoring, email, egress, retained backups,
and the existing Defender plan incur additional consumption charges.

### Combined monthly planning envelope

| Category | Monthly USD allowance | Basis |
| --- | --- | --- |
| Both databases: compute and provisioned storage | $153.39 | Observed SKU/storage meters, 730 hours |
| Web apps, short-lived jobs, and image-build compute | $100.00 | Low-volume baseline; verify admitted container sizes |
| Two Basic registries | $10.00 | Observed daily registry meter, rounded |
| Log ingestion | $23.00 | 10 GB/month combined at the observed $2.30/GB meter |
| Application-model use | $40.00 | Usage allowance, not reserved-throughput spending |
| Backups, evidence, network, email, Key Vault, and Defender | $110.00 | Conservative combined allowance; not a quoted Defender meter |
| Contingency | $63.61 | Headroom |
| Total planning ceiling | $500.00 | Not a technical spending cap |

This envelope assumes two low-traffic applications, not all maximum replicas
running continuously. Higher traffic, logs, model usage, retained data, taxes,
or contractual pricing can exceed it. Stop if validation requires a larger
configuration or reveals costs outside this envelope; do not silently resize,
remove protection, or request more quota. Public documentation did not expose
a directly verifiable Defender amount in the retrieved page, so its cost is
included as an allowance rather than a fabricated precise quote.

## Resource inventory and capacity qualifications

The full source footprint creates three Krypto resource groups, four OIDC
identities/federations, six runtime/scheduler/ops identities, two application
foundations, two web applications, fourteen jobs, and one dedicated Foundry
account with two deployments. Azure may create its own managed infrastructure
resources for the Container Apps environments.

| Resource class | New | Projected total after deployment | Capacity evidence |
| --- | --- | --- | --- |
| Krypto resource groups | 3 | 34 subscription groups before service-managed additions | Existing groups counted; ARM validation required |
| Container Apps environments | 2 | 4 in westus3 | Live quota 50 |
| Web Container Apps / jobs | 2 / 14 | 5 / 16 in westus3 | New environments; admitted compute and per-environment limits must pass |
| Virtual networks | 2 | 3 in westus3 | Live quota 1000 |
| Private DNS zones | 2 | 15 subscription-wide | New resource groups; provider validation required |
| Evidence storage accounts | 2 | 4 in westus3 | Live quota 250 |
| PostgreSQL Flexible Servers | 2 | 4 in westus3 | SKU/version/geo-backup capabilities observed; quota CLI returns BadRequest |
| Registries | 2 | 5 in westus3 | Names available; quota CLI returns BadRequest |
| Key Vaults | 2 | 4 in westus3 | Names available; quota CLI returns BadRequest |
| User-assigned managed identities | 10 | 13 in westus3 | No new Krypto identities exist yet; scoped deployment validation required |
| Communication / Email Services | 2 / 2 | 4 / 4 global | Communication names available; Azure-managed email domains |
| Log Analytics workspaces | 2 | 4 in westus3 | New workspace per environment; usage-based ingestion allowance |
| Action groups / scheduled-query alerts | 2 / 4 | 5 global action groups / 4 new alerts | One failed-job and one missing-success alert per environment |
| Foundry account | 1 | 2 in westus3 | Custom domain available; account-specific admission still required |
| Model deployments | 2 | 20 of 250 capacity units in westus3 | Exact model/version/GlobalStandard catalog and live quota |

Failed quota queries and absent published count limits are not evidence of
unlimited capacity. The public
[PostgreSQL limits page](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-limits)
documents connection and functional limits, not a server-count quota. Native
provider validation and fail-closed admission remain required; this preparation
record does not assert that all cloud checks have passed.

## Proposed permission and configuration effects

The following effects require explicit approval; no row is already authorized
by target, region, budget, or environment-scope selection.

| OIDC identity | Resource-group permissions | Subscription permissions |
| --- | --- | --- |
| Development | Contributor + Role Based Access Control Administrator on `rg-krypto-dev` | One-action provider-registration reader |
| Production deploy | Contributor + Role Based Access Control Administrator + Locks Contributor on `rg-krypto-prod` | One-action provider-registration reader |
| Production promotion | Contributor on `rg-krypto-prod` | None |
| Platform | Contributor + Role Based Access Control Administrator + Locks Contributor on `rg-krypto-platform` | Provider-registration reader + Cognitive Services Usages Reader |

These existing template roles are not being broadened. RBAC Administrator
can nevertheless assign powerful roles inside its resource group; it is not
limited to the named workload roles. The bootstrap operator's permission
listing allows group/deployment creation, role definitions/assignments, and
locks. No subscription-write permission is granted to a workflow identity.
The custom reader permits only
`Microsoft.Resources/subscriptions/providers/read`, not provider registration.

Workload bindings remain resource-scoped: image pull, Key Vault secret reads,
evidence access, and four runtime/ops OpenAI User grants on the shared model
account. The platform smoke principal also receives account-scoped inference
access. Preserve private PostgreSQL, Foundry local-auth disablement, production
delete locks, and existing 7-day dev / 90-day prod evidence retention. Do not
irreversibly lock evidence retention as part of this recovery approval.

Protected GitHub changes would replace Azure subscription/tenant/client
bindings in the four existing Environments using verified bootstrap outputs,
and update platform account/principal metadata. Fresh per-environment database
administrator/runtime passwords and database URLs are required. Do not display,
commit, or put their values in an issue. Other existing application-auth and
telemetry secrets remain in their respective protected Environments and are
consumed only by the trusted hosted release workflow. Replacing database
bindings does not migrate or alter the old Azure database.

## Execution and stop conditions

1. Complete source review and current-head CI through the recovery PR.
2. Obtain the exact provisioning/configuration approval and complete the
   Azure validation workflow. Keep native quota, name, policy, and role
   failures blocking; do not auto-escalate privileges or switch targets.
3. Bootstrap only the selected subscription, then re-read the produced
   identities and bind protected settings. Leave old Azure resources intact.
4. Validate/provision the dedicated account, model pair, both foundations,
   and the four workload inference bindings in their existing dependency order.
5. Configure fresh database bindings securely. Run the exact-SHA development
   release and its migration/smoke/activation/schedule observation path.
6. Run production only through its protected exact-SHA path, ending
   disabled/Manual. Required GitHub approvals remain effective.
7. If readiness passes, use the separately granted one-time factory resume
   authorization and observe the complete owned issue-to-merge-to-dev canary.
8. On failure, preserve diagnostics and force only the new environment's
   jobs to Manual and app to disabled before rollback. Do not delete resources,
   overwrite old data, remove locks/protections, or claim activation.

This is a fresh deployment, not a migration of inaccessible historical data.
No workflow dispatch, real-provider smoke, secret replacement, or provisioning
is authorized until the bounded plan approval is recorded.

## Protection-state observation

On 2026-10-21 the Environment API showed branch restrictions on `development`,
and required reviewers with `prevent_self_review` plus branch restrictions on
`platform`, `production-deploy`, and `production-promotion`. Allowed branches
are `main` and `develop/azure`. Development does not reference the legacy
`development-promotion` Environment.

Consequently, this infrastructure recovery alone cannot truthfully deliver
100% unattended production delivery. A separate, explicitly approved
production-protection/promotion design is still required. Do not remove or
bypass those protections under this plan.

## Proposed repair surfaces

- Correct only the stale GitHub owner parameters, retaining immutable-ID
  federation and resource-group-scoped deployment privileges.
- Reuse the existing Bicep architecture and exact-SHA development pipeline.
- Keep resource names, Key Vault, model endpoint, and identity bindings
  consistent across foundation, release, rollout, schedule monitoring, and
  rollback. Monitoring selects the same name prefix; activation uses compiled
  JSON parameters before applying its boolean/time overrides.
- Do not reuse the old cross-tenant Foundry endpoint or database URLs.
- Use the owner-selected full footprint: three resource groups, four OIDC
  identities, two model deployments, and both dev and prod workload
  identities. There is no new dev-only abstraction or automatic production
  activation path.
- Disclose each identity, role grant, protected-setting change, and secret
  prerequisite in the final approval request. No secret values are to be
  displayed or committed.

## Unresolved

- Independent model-host creation/admission and final service validation.
- Required Azure/GitHub identity setup and external service configuration.
- Formal validation, protected-workflow admission, and exact
  provisioning/permission approval.
- Production software-delivery scope, which remains manual and disabled.

## Validation and activation

No deployment or factory activation is authorized by this draft. Readiness
requires successful exact-SHA application deployment evidence, not a green
infrastructure-only job. The full factory canary has no recorded successful run.
