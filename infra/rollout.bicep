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

@description('Azure AI Foundry Anthropic base URL. Must match the value release.bicep deployed.')
param anthropicFoundryBaseUrl string

@description('Azure AI Foundry Claude deployment name. Must match the value release.bicep deployed.')
param anthropicFoundryDeployment string

@description('Azure AI Foundry Anthropic API version. Must match the value release.bicep deployed.')
param anthropicFoundryApiVersion string = '2024-10-21'

@description('PostHog ingestion host. Must match the value release.bicep deployed.')
param posthogHost string = 'https://us.i.posthog.com'

@description('Alert email recipient. Must match the value release.bicep deployed.')
param alertEmailTo string

@description('Alert email sender. Must match the value release.bicep deployed.')
param alertEmailFrom string

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

@description('Tags applied to rollout resources.')
param tags object = {
  project: 'project-krypto'
}

var envTags = union(tags, { environment: environmentName })
var webImageDigestRef = '${registryLoginServer}/${webImageName}@${imageDigest}'

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

resource anthropicFoundryApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'anthropic-foundry-api-key'
}

resource posthogApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'posthog-api-key'
}

resource resendApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'resend-api-key'
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
      { name: 'ANTHROPIC_FOUNDRY_BASE_URL', value: anthropicFoundryBaseUrl }
      { name: 'ANTHROPIC_FOUNDRY_DEPLOYMENT', value: anthropicFoundryDeployment }
      { name: 'ANTHROPIC_FOUNDRY_API_VERSION', value: anthropicFoundryApiVersion }
      { name: 'POSTHOG_HOST', value: posthogHost }
      { name: 'ALERT_EMAIL_TO', value: alertEmailTo }
      { name: 'ALERT_EMAIL_FROM', value: alertEmailFrom }
    ]
    keyVaultSecretEnv: [
      { name: 'DATABASE_URL', keyVaultUrl: databaseUrlSecret.properties.secretUri }
      { name: 'CRON_SECRET', keyVaultUrl: cronSecretSecret.properties.secretUri }
      { name: 'ANTHROPIC_FOUNDRY_API_KEY', keyVaultUrl: anthropicFoundryApiKeySecret.properties.secretUri }
      { name: 'POSTHOG_API_KEY', keyVaultUrl: posthogApiKeySecret.properties.secretUri }
      { name: 'RESEND_API_KEY', keyVaultUrl: resendApiKeySecret.properties.secretUri }
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
