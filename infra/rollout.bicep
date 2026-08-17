// Resource-group-scoped template: the ONLY template allowed to change
// ROLLOUT_MODE on the web Container App or switch the hourly/daily
// scheduler jobs between Manual and Schedule trigger types. It does not
// create or modify Key Vault secrets, role assignments, or any of the
// five manual operations jobs — those are release.bicep's responsibility
// and are left untouched here by reading their existing secret URIs
// rather than recreating them.
//
// Production must be deployed with rolloutMode 'disabled' and both
// trigger types 'Manual' by default (see
// infra/params/rollout.prod.bicepparam) — promotion to 'shadow'/'paper'
// and/or 'Schedule' is a separate, explicitly reviewed deploy of this
// template, never a side effect of release.bicep (ADR 0008 items 11-12).
//
// The hourly cron is fixed at "0 * * * *" UTC and the daily cron is fixed at
// "5 0 * * *" UTC. Both use replicaRetryLimit=0 and a 270-second replica
// timeout; invocation idempotency remains defense in depth. These are not
// parameters — this template's only variable surface is rolloutMode and the
// two trigger types.
//
// The hourly/daily jobs run
// `node --experimental-strip-types scripts/scheduled-trigger.mjs` (the
// .mjs entrypoint imports its .ts implementation at
// src/deployment/scheduled-trigger.ts, so the flag is required), never an
// inline shell/curl
// command, so the existing routes' x-required-rollout-mode/idempotency
// requirements are always satisfied and ROLLOUT_MODE here always matches
// what this same deploy just set on the web app.
//
// Deploy with:
//   az deployment group create \
//     --resource-group <rg-from-bootstrap-output> \
//     --template-file infra/rollout.bicep \
//     --parameters infra/params/rollout.dev.bicepparam
targetScope = 'resourceGroup'

@description('Short environment name: dev or prod.')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Azure region.')
param location string

@description('Existing Key Vault name (secrets must already exist from a prior release.bicep deploy).')
param keyVaultName string

@description('Existing Container Apps managed environment resource ID from environment.bicep output.')
param containerAppsEnvironmentId string

@description('Existing ACR login server from environment.bicep output.')
param registryLoginServer string

@description('Existing runtime identity resource ID from environment.bicep output.')
param runtimeIdentityId string

@description('Existing runtime identity client ID (appId) from environment.bicep output. Passed as AZURE_CLIENT_ID for Foundry managed-identity authentication.')
param runtimeIdentityClientId string

@description('Existing scheduler identity resource ID from environment.bicep output.')
param schedulerIdentityId string

@description('Web Container App name. Must match the name release.bicep deployed.')
param webAppName string = 'ca-${environmentName}-web'

@description('Hourly agent-run job name. Must match the name release.bicep deployed.')
param hourlyJobName string = 'caj-${environmentName}-agent-run'

@description('Daily summary job name. Must match the name release.bicep deployed.')
param dailyJobName string = 'caj-${environmentName}-daily-summary'

@description('ACR repository name for the web image. Must match what release.bicep currently has deployed — this template does not ship new images, only rollout-state changes.')
param webImageName string = 'krypto-web'

@description('Immutable digest of the web image, e.g. sha256:<64-hex>. Must match the digest currently deployed by release.bicep. Also used, unmodified, by the hourly/daily scheduler jobs, which run from the same image as the web app.')
@minLength(1)
param imageDigest string

@description('The 40-character lowercase-hex git commit SHA that produced the currently deployed image. Must match release.bicep.')
@minLength(40)
@maxLength(40)
param releaseSha string

@description('Fail-closed daily Coinbase request ceiling. Must match release.bicep.')
@minValue(1)
@maxValue(1000)
param coinbaseDailyRequestBudget int = 1000

@description('Fail-closed daily version-pinned Foundry invocation ceiling. Must match release.bicep.')
@minValue(1)
@maxValue(200)
param foundryDailyRequestBudget int = 200

@description('Fail-closed daily PostHog flush ceiling. Must match release.bicep.')
@minValue(1)
@maxValue(2000)
param posthogDailyRequestBudget int = 2000

@description('Fail-closed daily ACS Email send ceiling. Must match release.bicep.')
@minValue(1)
@maxValue(100)
param acsDailyRequestBudget int = 100

@description('Foundry project endpoint. Must match the value release.bicep deployed.')
param azureFoundryProjectEndpoint string

@description('Read-only Foundry decision agent name. Must match release.bicep.')
param azureFoundryAgentName string

@description('Immutable Foundry decision agent version. Must match release.bicep.')
param azureFoundryAgentVersion string

@description('Temporary compatibility switch for force-disabling a pre-agent image. Never enable for a newly released agent-integrated image.')
param legacyDirectModelCompatibility bool = false

@description('Legacy Azure OpenAI v1 base URL. Required only when legacyDirectModelCompatibility is true.')
param legacyAzureOpenAIBaseUrl string = ''

@description('Legacy Azure OpenAI deployment name. Required only when legacyDirectModelCompatibility is true.')
param legacyAzureOpenAIDeploymentName string = ''

@description('PostHog ingestion host. Must match the value release.bicep deployed.')
param posthogHost string = 'https://us.i.posthog.com'

@description('PostHog event environment tag. Must match release.bicep.')
@allowed([
  'dev'
  'prod'
])
param posthogEnvironment string = environmentName

@description('Alert email recipient. Must match the value release.bicep deployed.')
param alertEmailTo string

@description('Azure-managed ACS Email sender. Must match the value release.bicep deployed.')
param communicationEmailSender string

@description('Rollout mode. Production must default to disabled; promote only through an explicitly reviewed deploy of this template.')
@allowed([
  'disabled'
  'shadow'
  'paper'
])
param rolloutMode string = 'disabled'

@description('Hourly agent-run job trigger type. Production must default to Manual.')
@allowed([
  'Manual'
  'Schedule'
])
param hourlyTriggerType string = 'Manual'

@description('Daily summary job trigger type. Production must default to Manual.')
@allowed([
  'Manual'
  'Schedule'
])
param dailyTriggerType string = 'Manual'

@description('Numeric generation for scheduled-run idempotency. Schedule rollouts must supply the current activation epoch; Manual rollouts use 0.')
@minLength(1)
@maxLength(10)
param scheduleGenerationUnixSeconds string = '0'

@description('Tags applied to rollout resources.')
param tags object = {
  project: 'project-krypto'
}

var envTags = union(tags, { environment: environmentName })
var webImageDigestRef = '${registryLoginServer}/${webImageName}@${imageDigest}'
var parsedScheduleGeneration = int(scheduleGenerationUnixSeconds)
var validatedScheduleGeneration = hourlyTriggerType == 'Schedule' && parsedScheduleGeneration <= 0
  ? fail('scheduleGenerationUnixSeconds must be positive when the hourly trigger is Schedule.')
  : string(parsedScheduleGeneration)
var validatedLegacyAzureOpenAIBaseUrl = legacyDirectModelCompatibility && empty(legacyAzureOpenAIBaseUrl)
  ? fail('legacyAzureOpenAIBaseUrl is required when legacyDirectModelCompatibility is true.')
  : legacyAzureOpenAIBaseUrl
var validatedLegacyAzureOpenAIDeploymentName = legacyDirectModelCompatibility && empty(legacyAzureOpenAIDeploymentName)
  ? fail('legacyAzureOpenAIDeploymentName is required when legacyDirectModelCompatibility is true.')
  : legacyAzureOpenAIDeploymentName
var legacyDirectModelEnv = legacyDirectModelCompatibility
  ? [
      { name: 'AZURE_OPENAI_BASE_URL', value: validatedLegacyAzureOpenAIBaseUrl }
      { name: 'AZURE_OPENAI_DEPLOYMENT_NAME', value: validatedLegacyAzureOpenAIDeploymentName }
    ]
  : []

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: last(split(containerAppsEnvironmentId, '/'))
}

var targetBaseUrl = 'https://${webAppName}.${containerAppsEnvironment.properties.defaultDomain}'

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'database-url'
}

resource cronSecretSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'cron-secret'
}

resource posthogApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'posthog-api-key'
}

resource communicationConnectionStringSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'azure-communication-connection-string'
}

resource adminPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'admin-password'
}

resource adminSessionSecretSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'admin-session-secret'
}

module webApp 'modules/container-app-web.bicep' = {
  name: 'web-app-rollout'
  params: {
    appName: webAppName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: webImageDigestRef
    runtimeIdentityId: runtimeIdentityId
    rolloutMode: rolloutMode
    nonSecretEnv: concat([
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
      { name: 'RELEASE_SHA', value: releaseSha }
      { name: 'IMAGE_DIGEST', value: imageDigest }
      { name: 'EXECUTION_CONTRACT_VERSION', value: 'bounded-sync-v1' }
      { name: 'DATABASE_POOL_MAX', value: '1' }
      { name: 'AGENT_RUN_ADMISSION_CAPACITY', value: '1' }
      { name: 'COINBASE_DAILY_REQUEST_BUDGET', value: string(coinbaseDailyRequestBudget) }
      { name: 'FOUNDRY_DAILY_REQUEST_BUDGET', value: string(foundryDailyRequestBudget) }
      { name: 'POSTHOG_DAILY_REQUEST_BUDGET', value: string(posthogDailyRequestBudget) }
      { name: 'ACS_DAILY_REQUEST_BUDGET', value: string(acsDailyRequestBudget) }
    ], legacyDirectModelEnv)
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
}

module hourlyAgentRunJob 'modules/container-app-job.bicep' = {
  name: 'hourly-agent-run-job-rollout'
  params: {
    jobName: hourlyJobName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: webImageDigestRef
    jobIdentityId: schedulerIdentityId
    triggerType: hourlyTriggerType
    cronExpression: '0 * * * *'
    replicaRetryLimit: 0
    replicaTimeoutSeconds: 270
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
      { name: 'ROLLOUT_MODE', value: rolloutMode }
      { name: 'SCHEDULED_IDEMPOTENCY_NAMESPACE', value: '${imageDigest}-${validatedScheduleGeneration}' }
      { name: 'RELEASE_SHA', value: releaseSha }
      { name: 'IMAGE_DIGEST', value: imageDigest }
      { name: 'EXECUTION_CONTRACT_VERSION', value: 'bounded-sync-v1' }
    ]
    keyVaultSecretEnv: [
      { name: 'CRON_SECRET', keyVaultUrl: cronSecretSecret.properties.secretUri }
    ]
    tags: envTags
  }
}

module dailySummaryJob 'modules/container-app-job.bicep' = {
  name: 'daily-summary-job-rollout'
  params: {
    jobName: dailyJobName
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: webImageDigestRef
    jobIdentityId: schedulerIdentityId
    triggerType: dailyTriggerType
    cronExpression: '5 0 * * *'
    replicaRetryLimit: 0
    replicaTimeoutSeconds: 270
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
      { name: 'ROLLOUT_MODE', value: rolloutMode }
      { name: 'RELEASE_SHA', value: releaseSha }
      { name: 'IMAGE_DIGEST', value: imageDigest }
      { name: 'EXECUTION_CONTRACT_VERSION', value: 'bounded-sync-v1' }
    ]
    keyVaultSecretEnv: [
      { name: 'CRON_SECRET', keyVaultUrl: cronSecretSecret.properties.secretUri }
    ]
    tags: envTags
  }
}

output webAppFqdn string = webApp.outputs.fqdn
output rolloutMode string = rolloutMode
output hourlyTriggerType string = hourlyTriggerType
output dailyTriggerType string = dailyTriggerType
output scheduleGenerationUnixSeconds string = validatedScheduleGeneration
