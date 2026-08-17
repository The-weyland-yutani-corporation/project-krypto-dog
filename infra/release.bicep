// Resource-group-scoped template: deploys the external Next.js web
// Container App, the hourly/daily scheduler Container Apps Jobs, and the
// five manual operations Container Apps Jobs, using Key Vault references
// resolved through per-secret RBAC. This is the only template that
// creates the Key Vault secret objects themselves; their values are
// supplied as @secure() parameters at deploy time and must never be
// committed to a .bicepparam file.
//
// Web receives DATABASE_URL but never DIRECT_URL or MIGRATION_URL. The scheduler identity
// (hourly/daily jobs) is granted access to only the cron secret — the
// jobs run `node --experimental-strip-types scripts/scheduled-trigger.mjs`
// (the .mjs entrypoint imports its .ts implementation at
// src/deployment/scheduled-trigger.ts, so the flag is required), never an
// inline shell/curl
// command, so the x-required-rollout-mode header and per-hour idempotency
// key the existing routes require are always attached correctly. The ops
// identity (shared, for now, across all five manual jobs) is granted only
// the secrets at least one of those jobs actually reads — DATABASE_URL,
// DIRECT_URL, MIGRATION_URL, CRON_SECRET, ADMIN_PASSWORD, plus POSTHOG_API_KEY
// (target-smoke only, since src/deployment/target-smoke.ts's
// runTargetSmoke() directly exercises that provider) and
// migrator-database-password / KRYPTO_MIGRATOR_LOGIN_PASSWORD and
// runtime-database-password /
// AZURE_RUNTIME_LOGIN_PASSWORD (migrate-init only, for the fresh-
// deployment runtime login role bootstrap) — never the ACS connection
// string or ADMIN_SESSION_SECRET, which no operation reads. Foundry uses
// the ops job's managed identity rather than a model API key. Each job
// resource's own env/secret list is narrowed further still to just what
// that one operation reads (see scripts/azure/ops-job.ts and
// scripts/azure/operations/*.ts) even where the ops identity's Key Vault
// RBAC is broader than any single job's own mounted env.
//
// Scheduler jobs always land here with triggerType 'Manual' and
// ROLLOUT_MODE 'disabled' on the web app, regardless of parameters — only
// rollout.bicep may change either. Re-running this template (e.g. to ship
// a new image digest) re-lands both at their disabled/manual defaults,
// which matches ADR 0008 item 12 (deploy and schedule activation are two
// separately approved steps).
//
// Deploy with:
//   az deployment group create \
//     --resource-group <rg-from-bootstrap-output> \
//     --template-file infra/release.bicep \
//     --parameters infra/params/release.dev.bicepparam \
//     --parameters databaseUrl=<supplied-at-deploy-time> \
//                  cronSecret=<supplied-at-deploy-time> \
//                  ... (see infra/README.md for the full secret list)
targetScope = 'resourceGroup'

@description('Short environment name: dev or prod.')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Azure region.')
param location string

@description('Existing Key Vault name from environment.bicep output.')
param keyVaultName string

@description('Existing Container Apps managed environment resource ID from environment.bicep output.')
param containerAppsEnvironmentId string

@description('Existing ACR login server from environment.bicep output.')
param registryLoginServer string

@description('Existing runtime identity resource ID from environment.bicep output.')
param runtimeIdentityId string

@description('Existing runtime identity client ID (appId) from environment.bicep output. Passed as AZURE_CLIENT_ID so Azure Identity selects this user-assigned identity for Foundry authentication.')
param runtimeIdentityClientId string

@description('Existing scheduler identity resource ID from environment.bicep output.')
param schedulerIdentityId string

@description('Existing scheduler identity principal ID from environment.bicep output.')
param schedulerIdentityPrincipalId string

@description('Existing ops identity resource ID from environment.bicep output. Shared, for now, across all five manual operations jobs.')
param opsIdentityId string

@description('Existing ops identity principal ID from environment.bicep output.')
param opsIdentityPrincipalId string

@description('Existing ops identity client ID (appId) from environment.bicep output. Nonsecret — passed to every operations job as AZCOPY_MSI_CLIENT_ID so AzCopy subprocess invocations that set AZCOPY_AUTO_LOGIN_TYPE=MSI authenticate as this specific user-assigned identity rather than an ambiguous/system-assigned one. Does not enable or require SystemAssigned identity on the job; the ops jobs remain UserAssigned-only.')
param opsIdentityClientId string

@description('Existing runtime identity principal ID from environment.bicep output.')
param runtimeIdentityPrincipalId string

@description('Full bare HTTPS evidence container URL from environment.bicep output (EVIDENCE_CONTAINER_URL — managed-identity auth only, never a credential/query string embedded in the URL). Passed to every operations job as a non-secret env var.')
param evidenceContainerUrl string

@description('Existing Azure Communication Services resource name from environment.bicep output. Its connection string is written directly to Key Vault with listKeys() and is never passed through GitHub.')
param communicationServiceName string

@description('Azure-managed ACS Email sender address from environment.bicep output.')
param communicationEmailSender string

@description('Web Container App name.')
param webAppName string = 'ca-${environmentName}-web'

@description('Hourly agent-run job name.')
param hourlyJobName string = 'caj-${environmentName}-agent-run'

@description('Daily summary job name.')
param dailyJobName string = 'caj-${environmentName}-daily-summary'

@description('Migration/one-time-init operations job name.')
param migrateInitJobName string = 'caj-${environmentName}-migrate-init'

@description('Deployment preflight operations job name.')
param preflightJobName string = 'caj-${environmentName}-preflight'

@description('Verified backup operations job name.')
param verifiedBackupJobName string = 'caj-${environmentName}-verified-backup'

@description('Target smoke operations job name.')
param targetSmokeJobName string = 'caj-${environmentName}-target-smoke'

@description('Schedule-activation-check operations job name.')
param activationCheckJobName string = 'caj-${environmentName}-activation-check'

@description('ACR repository name for the web image (also used, unmodified, by the hourly/daily scheduler jobs — they run `node --experimental-strip-types scripts/scheduled-trigger.mjs` from the same image as the web app, per the Dockerfile\'s `web` build target).')
param webImageName string = 'krypto-web'

@description('Immutable digest of the web image, e.g. sha256:<64-hex>. Never a mutable tag such as :latest. Combined with webImageName/registryLoginServer to form the full image reference, and passed verbatim as IMAGE_DIGEST to the target-smoke and activation-check operations jobs so there is exactly one source of truth for "which release is this" — it cannot drift from the image the web app and scheduler jobs actually run.')
@minLength(1)
param imageDigest string

@description('ACR repository name for the ops image (the Dockerfile\'s `ops` build target: full source, full dependency graph, PostgreSQL 17 client/server binaries, and AzCopy).')
param opsImageName string = 'krypto-ops'

@description('Immutable digest of the ops image, e.g. sha256:<64-hex>. Never a mutable tag such as :latest.')
@minLength(1)
param opsImageDigest string

@description('The 40-character lowercase-hex git commit SHA that produced this release. Passed to every operations job as RELEASE_SHA (see scripts/azure/lib/report-path.ts) — never guessed or derived from the image digest.')
@minLength(40)
@maxLength(40)
param releaseSha string

@description('Environment-specific Foundry project endpoint used for prompt-agent invocation.')
param azureFoundryProjectEndpoint string

@description('Environment-specific read-only Foundry decision agent name.')
param azureFoundryAgentName string

@description('Immutable Foundry decision agent version.')
param azureFoundryAgentVersion string

@description('PostHog ingestion host.')
param posthogHost string = 'https://us.i.posthog.com'

@description('PostHog event environment tag. Keeps dev/prod events query-isolated even during a temporary shared-key fallback.')
@allowed([
  'dev'
  'prod'
])
param posthogEnvironment string = environmentName

@description('Alert email recipient.')
param alertEmailTo string

@description('Fresh-deployment Azure PostgreSQL runtime login role name (see src/deployment/bootstrap-runtime-role.ts / AZURE_RUNTIME_LOGIN_ROLE). Nonsecret — it is a role name, not a credential. Passed only to the migrate-init operations job, which is the one operation that may need to create/rotate this login role\'s credential and grant it krypto_runtime membership on a fresh environment.')
param runtimeDatabaseLoginRole string = 'krypto_app'

@description('Runtime pooler connection string. Supplied at deploy time; never committed.')
@secure()
param databaseUrl string

@description('Server-admin/operator connection string. Supplied at deploy time; never committed. Used only by protected operations jobs for role bootstrap, inventory, backup, and evidence checks; migrations use migrationUrl instead. Never granted to runtime or scheduler.')
@secure()
param directUrl string

@description('Dedicated direct PostgreSQL migration connection string authenticating as krypto_migrator. Supplied at deploy time; never committed. Mounted only on migrate-init and preflight, never on web, scheduler, smoke, backup, or activation jobs.')
@secure()
param migrationUrl string

@description('Shared secret validating the x-cron-secret header on /api/agent/run and /api/agent/daily-summary. Supplied at deploy time; never committed.')
@secure()
param cronSecret string

@description('PostHog API key. Supplied at deploy time; never committed.')
@secure()
param posthogApiKey string

@description('Admin dashboard password. Supplied at deploy time; never committed. Also required by the target-smoke operations job.')
@secure()
param adminPassword string

@description('Dedicated HMAC key for admin session cookies. Supplied at deploy time; never committed. Granted to the runtime identity only — no operations job needs it.')
@secure()
param adminSessionSecret string

@description('Fresh-deployment Azure PostgreSQL runtime login role password (AZURE_RUNTIME_LOGIN_PASSWORD — see src/deployment/bootstrap-runtime-role.ts). Supplied at deploy time; never committed. Granted only to the migrate-init operations job — no other job or identity needs it, since it exists solely to create/rotate the runtime login role\'s own credential on a fresh environment.')
@secure()
param runtimeDatabasePassword string

@description('Dedicated PostgreSQL migrator password (KRYPTO_MIGRATOR_LOGIN_PASSWORD). Supplied at deploy time; never committed. Granted only to the protected ops identity and mounted only on migrate-init so the admin bootstrap can create or rotate krypto_migrator before MIGRATION_URL is used.')
@secure()
param migratorDatabasePassword string

@description('Shared deployment-approval secret validating that a target-smoke or activation-check invocation is an authorized part of a real deploy/rollout, not an arbitrary manual trigger. Supplied at deploy time; never committed. Granted only to the ops identity, and mounted as DEPLOYMENT_APPROVAL_SECRET only on the target-smoke and activation-check jobs — never the web app, the scheduler jobs, or the other three ops jobs (migrate-init, preflight, verified-backup), none of which need it.')
@secure()
param deploymentApprovalSecret string

@description('Tags applied to release resources.')
param tags object = {
  project: 'project-krypto'
}

var envTags = union(tags, { environment: environmentName })
var webImageDigestRef = '${registryLoginServer}/${webImageName}@${imageDigest}'
var opsImageDigestRef = '${registryLoginServer}/${opsImageName}@${opsImageDigest}'

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource communicationService 'Microsoft.Communication/communicationServices@2025-09-01' existing = {
  name: communicationServiceName
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: last(split(containerAppsEnvironmentId, '/'))
}

// An "origin"/"base URL" for the deployed web app: scheme + host, no path.
// APP_ORIGIN makes CSRF validation independent of the reverse proxy's internal
// request URL. The same value is reused for scheduler and evidence checks.
var targetBaseUrl = 'https://${webAppName}.${containerAppsEnvironment.properties.defaultDomain}'

// Each application secret is its own named resource (rather than a loop
// array) so every role assignment below can scope to an unambiguous,
// statically named resource symbol instead of a dynamically computed
// array index.
resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'database-url'
  properties: {
    value: databaseUrl
  }
}

resource directUrlSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'direct-url'
  properties: {
    value: directUrl
  }
}

resource migrationUrlSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'migration-url'
  properties: {
    value: migrationUrl
  }
}

resource cronSecretSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'cron-secret'
  properties: {
    value: cronSecret
  }
}

resource posthogApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'posthog-api-key'
  properties: {
    value: posthogApiKey
  }
}

resource communicationConnectionStringSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'azure-communication-connection-string'
  properties: {
    value: communicationService.listKeys().primaryConnectionString
  }
}

resource adminPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'admin-password'
  properties: {
    value: adminPassword
  }
}

resource adminSessionSecretSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'admin-session-secret'
  properties: {
    value: adminSessionSecret
  }
}

resource runtimeDatabasePasswordSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'runtime-database-password'
  properties: {
    value: runtimeDatabasePassword
  }
}

resource migratorDatabasePasswordSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'migrator-database-password'
  properties: {
    value: migratorDatabasePassword
  }
}

resource deploymentApprovalSecretSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: 'deployment-approval-secret'
  properties: {
    value: deploymentApprovalSecret
  }
}

// --- Key Vault Secrets User role assignments, scoped to individual secrets ---
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

// Runtime (web): every application secret except direct-url.
resource runtimeDatabaseUrlAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'database-url', runtimeIdentityPrincipalId, 'runtime')
  scope: databaseUrlSecret
  properties: {
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource runtimeCronSecretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'cron-secret', runtimeIdentityPrincipalId, 'runtime')
  scope: cronSecretSecret
  properties: {
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource runtimePosthogApiKeyAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'posthog-api-key', runtimeIdentityPrincipalId, 'runtime')
  scope: posthogApiKeySecret
  properties: {
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource runtimeCommunicationConnectionStringAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'azure-communication-connection-string', runtimeIdentityPrincipalId, 'runtime')
  scope: communicationConnectionStringSecret
  properties: {
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource runtimeAdminPasswordAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'admin-password', runtimeIdentityPrincipalId, 'runtime')
  scope: adminPasswordSecret
  properties: {
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource runtimeAdminSessionSecretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'admin-session-secret', runtimeIdentityPrincipalId, 'runtime')
  scope: adminSessionSecretSecret
  properties: {
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

// Scheduler (hourly/daily jobs): cron secret only — scripts/scheduled-trigger.mjs
// needs nothing else.
resource schedulerCronSecretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'cron-secret', schedulerIdentityPrincipalId, 'scheduler')
  scope: cronSecretSecret
  properties: {
    principalId: schedulerIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

// Ops (shared across all five manual jobs, for now): only the secrets at
// least one operation actually reads. migrate-init: DIRECT_URL,
// DATABASE_URL (drizzle-kit migrate + scripts/seed.ts both read
// DIRECT_URL; scripts/seed.ts's underlying account-init path also reads
// DATABASE_URL), plus the fresh-deployment runtime-login-role credential
// (runtime-database-password, AZURE_RUNTIME_LOGIN_PASSWORD). preflight
// and verified-backup: DATABASE_URL + DIRECT_URL. target-smoke:
// CRON_SECRET + ADMIN_PASSWORD + DIRECT_URL, plus POSTHOG_API_KEY because
// src/deployment/target-smoke.ts's runTargetSmoke() calls
// runProviderSmoke(), which directly exercises PostHog (see
// src/deployment/provider-smoke.ts). Foundry uses this identity's Entra
// token, and target smoke asks the runtime app to send email, so the ops
// identity needs neither a model key nor the ACS connection string.
// activation-check: CRON_SECRET + DIRECT_URL. None of the five ops scripts
// need ADMIN_SESSION_SECRET.
resource opsDatabaseUrlAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'database-url', opsIdentityPrincipalId, 'ops')
  scope: databaseUrlSecret
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource opsDirectUrlAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'direct-url', opsIdentityPrincipalId, 'ops')
  scope: directUrlSecret
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource opsMigrationUrlAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'migration-url', opsIdentityPrincipalId, 'ops')
  scope: migrationUrlSecret
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource opsCronSecretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'cron-secret', opsIdentityPrincipalId, 'ops')
  scope: cronSecretSecret
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource opsAdminPasswordAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'admin-password', opsIdentityPrincipalId, 'ops')
  scope: adminPasswordSecret
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource opsPosthogApiKeyAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'posthog-api-key', opsIdentityPrincipalId, 'ops')
  scope: posthogApiKeySecret
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

// migrate-init only: fresh-deployment runtime login role bootstrap (see
// src/deployment/bootstrap-runtime-role.ts / AZURE_RUNTIME_LOGIN_PASSWORD).
resource opsRuntimeDatabasePasswordAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'runtime-database-password', opsIdentityPrincipalId, 'ops')
  scope: runtimeDatabasePasswordSecret
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource opsMigratorDatabasePasswordAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'migrator-database-password', opsIdentityPrincipalId, 'ops')
  scope: migratorDatabasePasswordSecret
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

// target-smoke and activation-check only: shared deployment-approval
// secret. Never granted to the runtime/scheduler identities and never
// mounted on migrate-init/preflight/verified-backup, which have no use
// for it.
resource opsDeploymentApprovalSecretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'deployment-approval-secret', opsIdentityPrincipalId, 'ops')
  scope: deploymentApprovalSecretSecret
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

module webApp 'modules/container-app-web.bicep' = {
  name: 'web-app'
  params: {
    appName: webAppName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: webImageDigestRef
    runtimeIdentityId: runtimeIdentityId
    rolloutMode: 'disabled'
    nonSecretEnv: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'AZURE_FOUNDRY_PROJECT_ENDPOINT', value: azureFoundryProjectEndpoint }
      { name: 'AZURE_FOUNDRY_AGENT_NAME', value: azureFoundryAgentName }
      { name: 'AZURE_FOUNDRY_AGENT_VERSION', value: azureFoundryAgentVersion }
      { name: 'AZURE_CLIENT_ID', value: runtimeIdentityClientId }
      { name: 'APP_ORIGIN', value: targetBaseUrl }
      { name: 'POSTHOG_HOST', value: posthogHost }
      { name: 'POSTHOG_ENVIRONMENT', value: posthogEnvironment }
      { name: 'ALERT_EMAIL_TO', value: alertEmailTo }
      { name: 'AZURE_COMMUNICATION_EMAIL_SENDER', value: communicationEmailSender }
    ]
    keyVaultSecretEnv: [
      { name: 'DATABASE_URL', keyVaultUrl: databaseUrlSecret.properties.secretUri }
      { name: 'CRON_SECRET', keyVaultUrl: cronSecretSecret.properties.secretUri }
      { name: 'POSTHOG_API_KEY', keyVaultUrl: posthogApiKeySecret.properties.secretUri }
      { name: 'AZURE_COMMUNICATION_CONNECTION_STRING', keyVaultUrl: communicationConnectionStringSecret.properties.secretUri }
      { name: 'ADMIN_PASSWORD', keyVaultUrl: adminPasswordSecret.properties.secretUri }
      { name: 'ADMIN_SESSION_SECRET', keyVaultUrl: adminSessionSecretSecret.properties.secretUri }
    ]
    tags: envTags
  }
  dependsOn: [
    runtimeDatabaseUrlAccess
    runtimeCronSecretAccess
    runtimePosthogApiKeyAccess
    runtimeCommunicationConnectionStringAccess
    runtimeAdminPasswordAccess
    runtimeAdminSessionSecretAccess
  ]
}

module hourlyAgentRunJob 'modules/container-app-job.bicep' = {
  name: 'hourly-agent-run-job'
  params: {
    jobName: hourlyJobName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: webImageDigestRef
    jobIdentityId: schedulerIdentityId
    triggerType: 'Manual'
    replicaRetryLimit: 1
    replicaTimeoutSeconds: 300
    command: [
      'node'
    ]
    args: [
      '--experimental-strip-types'
      'scripts/scheduled-trigger.mjs'
    ]
    nonSecretEnv: [
      { name: 'TARGET_BASE_URL', value: targetBaseUrl }
      { name: 'SCHEDULED_ROUTE', value: '/api/agent/run' }
      { name: 'ROLLOUT_MODE', value: 'disabled' }
      { name: 'SCHEDULED_IDEMPOTENCY_NAMESPACE', value: '${imageDigest}-0' }
    ]
    keyVaultSecretEnv: [
      { name: 'CRON_SECRET', keyVaultUrl: cronSecretSecret.properties.secretUri }
    ]
    tags: envTags
  }
  dependsOn: [
    schedulerCronSecretAccess
  ]
}

module dailySummaryJob 'modules/container-app-job.bicep' = {
  name: 'daily-summary-job'
  params: {
    jobName: dailyJobName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: webImageDigestRef
    jobIdentityId: schedulerIdentityId
    triggerType: 'Manual'
    replicaRetryLimit: 0
    replicaTimeoutSeconds: 300
    command: [
      'node'
    ]
    args: [
      '--experimental-strip-types'
      'scripts/scheduled-trigger.mjs'
    ]
    nonSecretEnv: [
      { name: 'TARGET_BASE_URL', value: targetBaseUrl }
      { name: 'SCHEDULED_ROUTE', value: '/api/agent/daily-summary' }
      { name: 'ROLLOUT_MODE', value: 'disabled' }
    ]
    keyVaultSecretEnv: [
      { name: 'CRON_SECRET', keyVaultUrl: cronSecretSecret.properties.secretUri }
    ]
    tags: envTags
  }
  dependsOn: [
    schedulerCronSecretAccess
  ]
}

// Non-secret env common to every manual operations job (see
// scripts/azure/ops-job.ts main()). JOB_EXECUTION_ID is deliberately NOT
// listed here — it has no meaningful committed value and must be supplied
// per-invocation via `az containerapp job start --env-vars
// JOB_EXECUTION_ID=<value>` so a repeat/duplicate invocation can never
// silently collide on the same immutable evidence destination.
var opsCommonNonSecretEnv = [
  { name: 'ENVIRONMENT_NAME', value: environmentName }
  { name: 'RELEASE_SHA', value: releaseSha }
  { name: 'EVIDENCE_CONTAINER_URL', value: evidenceContainerUrl }
  // AzCopy (invoked as a subprocess by the ops scripts for evidence/backup
  // transfer) reads AZCOPY_AUTO_LOGIN_TYPE=MSI + AZCOPY_MSI_CLIENT_ID to
  // authenticate as this specific user-assigned identity. Without an
  // explicit client ID, AzCopy's MSI login is ambiguous on a job that
  // could otherwise have more than one identity attached, and silently
  // falls back to a system-assigned identity that these jobs do not have
  // (they remain UserAssigned-only — no SystemAssigned identity is
  // enabled anywhere in this template).
  { name: 'AZCOPY_MSI_CLIENT_ID', value: opsIdentityClientId }
  { name: 'AZURE_CLIENT_ID', value: opsIdentityClientId }
]

module migrateInitJob 'modules/container-app-job.bicep' = {
  name: 'migrate-init-job'
  params: {
    jobName: migrateInitJobName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: opsImageDigestRef
    jobIdentityId: opsIdentityId
    triggerType: 'Manual'
    replicaRetryLimit: 0
    replicaTimeoutSeconds: 900
    command: [
      'npm'
    ]
    args: [
      'run'
      'azure:ops-job'
    ]
    nonSecretEnv: concat(opsCommonNonSecretEnv, [
      { name: 'OPERATION', value: 'migrate-init' }
      // Fresh-deployment Azure runtime login role name (nonsecret — see
      // src/deployment/bootstrap-runtime-role.ts / AZURE_RUNTIME_LOGIN_ROLE).
      { name: 'AZURE_RUNTIME_LOGIN_ROLE', value: runtimeDatabaseLoginRole }
    ])
    keyVaultSecretEnv: [
      { name: 'DIRECT_URL', keyVaultUrl: directUrlSecret.properties.secretUri }
      { name: 'MIGRATION_URL', keyVaultUrl: migrationUrlSecret.properties.secretUri }
      // scripts/seed.ts's account-init path also reads DATABASE_URL.
      { name: 'DATABASE_URL', keyVaultUrl: databaseUrlSecret.properties.secretUri }
      { name: 'KRYPTO_MIGRATOR_LOGIN_PASSWORD', keyVaultUrl: migratorDatabasePasswordSecret.properties.secretUri }
      // Fresh-deployment runtime login role credential — granted only to
      // this job, never to preflight/verified-backup/target-smoke/
      // activation-check.
      { name: 'AZURE_RUNTIME_LOGIN_PASSWORD', keyVaultUrl: runtimeDatabasePasswordSecret.properties.secretUri }
    ]
    tags: envTags
  }
  dependsOn: [
    opsDirectUrlAccess
    opsMigrationUrlAccess
    opsDatabaseUrlAccess
    opsMigratorDatabasePasswordAccess
    opsRuntimeDatabasePasswordAccess
  ]
}

module preflightJob 'modules/container-app-job.bicep' = {
  name: 'preflight-job'
  params: {
    jobName: preflightJobName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: opsImageDigestRef
    jobIdentityId: opsIdentityId
    triggerType: 'Manual'
    replicaRetryLimit: 0
    replicaTimeoutSeconds: 300
    command: [
      'npm'
    ]
    args: [
      'run'
      'azure:ops-job'
    ]
    nonSecretEnv: concat(opsCommonNonSecretEnv, [
      { name: 'OPERATION', value: 'preflight' }
    ])
    keyVaultSecretEnv: [
      { name: 'DATABASE_URL', keyVaultUrl: databaseUrlSecret.properties.secretUri }
      { name: 'DIRECT_URL', keyVaultUrl: directUrlSecret.properties.secretUri }
      { name: 'MIGRATION_URL', keyVaultUrl: migrationUrlSecret.properties.secretUri }
    ]
    tags: envTags
  }
  dependsOn: [
    opsDatabaseUrlAccess
    opsDirectUrlAccess
    opsMigrationUrlAccess
  ]
}

module verifiedBackupJob 'modules/container-app-job.bicep' = {
  name: 'verified-backup-job'
  params: {
    jobName: verifiedBackupJobName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: opsImageDigestRef
    jobIdentityId: opsIdentityId
    triggerType: 'Manual'
    replicaRetryLimit: 0
    replicaTimeoutSeconds: 3600
    command: [
      'npm'
    ]
    args: [
      'run'
      'azure:ops-job'
    ]
    nonSecretEnv: concat(opsCommonNonSecretEnv, [
      { name: 'OPERATION', value: 'verified-backup' }
    ])
    keyVaultSecretEnv: [
      { name: 'DATABASE_URL', keyVaultUrl: databaseUrlSecret.properties.secretUri }
      { name: 'DIRECT_URL', keyVaultUrl: directUrlSecret.properties.secretUri }
    ]
    tags: envTags
  }
  dependsOn: [
    opsDatabaseUrlAccess
    opsDirectUrlAccess
  ]
}

module targetSmokeJob 'modules/container-app-job.bicep' = {
  name: 'target-smoke-job'
  params: {
    jobName: targetSmokeJobName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: opsImageDigestRef
    jobIdentityId: opsIdentityId
    triggerType: 'Manual'
    replicaRetryLimit: 0
    replicaTimeoutSeconds: 300
    command: [
      'npm'
    ]
    args: [
      'run'
      'azure:ops-job'
    ]
    nonSecretEnv: concat(opsCommonNonSecretEnv, [
      { name: 'OPERATION', value: 'target-smoke' }
      { name: 'TARGET_BASE_URL', value: targetBaseUrl }
      // TARGET_CONFIRM_HOST is scripts/azure/operations/target-smoke.ts's
      // expected-hostname env var. No custom domain is provisioned by
      // this infra tree yet, so it is the Container App's own FQDN.
      { name: 'TARGET_CONFIRM_HOST', value: webApp.outputs.fqdn }
      { name: 'IMAGE_DIGEST', value: imageDigest }
      // src/deployment/target-smoke.ts's runTargetSmoke() hard-requires
      // ROLLOUT_MODE=disabled before it will run at all.
      { name: 'ROLLOUT_MODE', value: 'disabled' }
      // runTargetSmoke() -> runProviderSmoke() exercises Foundry and
      // PostHog directly. Foundry authenticates as the ops user-assigned
      // identity selected by AZURE_CLIENT_ID in opsCommonNonSecretEnv.
      { name: 'AZURE_FOUNDRY_PROJECT_ENDPOINT', value: azureFoundryProjectEndpoint }
      { name: 'AZURE_FOUNDRY_AGENT_NAME', value: azureFoundryAgentName }
      { name: 'AZURE_FOUNDRY_AGENT_VERSION', value: azureFoundryAgentVersion }
      { name: 'POSTHOG_HOST', value: posthogHost }
      { name: 'POSTHOG_ENVIRONMENT', value: posthogEnvironment }
    ])
    keyVaultSecretEnv: [
      { name: 'CRON_SECRET', keyVaultUrl: cronSecretSecret.properties.secretUri }
      { name: 'ADMIN_PASSWORD', keyVaultUrl: adminPasswordSecret.properties.secretUri }
      { name: 'DIRECT_URL', keyVaultUrl: directUrlSecret.properties.secretUri }
      { name: 'POSTHOG_API_KEY', keyVaultUrl: posthogApiKeySecret.properties.secretUri }
      { name: 'DEPLOYMENT_APPROVAL_SECRET', keyVaultUrl: deploymentApprovalSecretSecret.properties.secretUri }
    ]
    tags: envTags
  }
  dependsOn: [
    opsCronSecretAccess
    opsAdminPasswordAccess
    opsDirectUrlAccess
    opsPosthogApiKeyAccess
    opsDeploymentApprovalSecretAccess
  ]
}

module activationCheckJob 'modules/container-app-job.bicep' = {
  name: 'activation-check-job'
  params: {
    jobName: activationCheckJobName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: opsImageDigestRef
    jobIdentityId: opsIdentityId
    triggerType: 'Manual'
    replicaRetryLimit: 0
    replicaTimeoutSeconds: 300
    command: [
      'npm'
    ]
    args: [
      'run'
      'azure:ops-job'
    ]
    nonSecretEnv: concat(opsCommonNonSecretEnv, [
      { name: 'OPERATION', value: 'activation-check' }
      { name: 'TARGET_ORIGIN', value: targetBaseUrl }
      { name: 'IMAGE_DIGEST', value: imageDigest }
    ])
    keyVaultSecretEnv: [
      { name: 'CRON_SECRET', keyVaultUrl: cronSecretSecret.properties.secretUri }
      { name: 'DIRECT_URL', keyVaultUrl: directUrlSecret.properties.secretUri }
      { name: 'DEPLOYMENT_APPROVAL_SECRET', keyVaultUrl: deploymentApprovalSecretSecret.properties.secretUri }
    ]
    tags: envTags
  }
  dependsOn: [
    opsCronSecretAccess
    opsDirectUrlAccess
    opsDeploymentApprovalSecretAccess
  ]
}

output webAppFqdn string = webApp.outputs.fqdn
output hourlyJobName string = hourlyAgentRunJob.outputs.jobName
output dailyJobName string = dailySummaryJob.outputs.jobName
output migrateInitJobName string = migrateInitJob.outputs.jobName
output preflightJobName string = preflightJob.outputs.jobName
output verifiedBackupJobName string = verifiedBackupJob.outputs.jobName
output targetSmokeJobName string = targetSmokeJob.outputs.jobName
output activationCheckJobName string = activationCheckJob.outputs.jobName
