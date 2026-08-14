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
// The hourly cron is fixed at "0 * * * *" UTC with a replica retry limit
// of 1; the daily cron is fixed at "5 0 * * *" UTC with a replica retry
// limit of 0. These are not parameters — this template's only variable
// surface is rolloutMode and the two trigger types.
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

@description('Azure OpenAI v1 base URL. Must match the value release.bicep deployed.')
param azureOpenAIBaseUrl string

@description('Azure OpenAI model deployment name. Must match the value release.bicep deployed.')
param azureOpenAIDeploymentName string

@description('PostHog ingestion host. Must match the value release.bicep deployed.')
param posthogHost string = 'https://us.i.posthog.com'

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

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

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
    nonSecretEnv: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'AZURE_OPENAI_BASE_URL', value: azureOpenAIBaseUrl }
      { name: 'AZURE_OPENAI_DEPLOYMENT_NAME', value: azureOpenAIDeploymentName }
      { name: 'AZURE_CLIENT_ID', value: runtimeIdentityClientId }
      { name: 'POSTHOG_HOST', value: posthogHost }
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
}

var targetBaseUrl = 'https://${webApp.outputs.fqdn}'

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
      { name: 'ROLLOUT_MODE', value: rolloutMode }
      { name: 'SCHEDULED_IDEMPOTENCY_NAMESPACE', value: '${imageDigest}-${validatedScheduleGeneration}' }
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
      { name: 'ROLLOUT_MODE', value: rolloutMode }
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
