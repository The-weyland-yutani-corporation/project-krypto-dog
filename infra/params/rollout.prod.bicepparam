// Nonsecret prod rollout parameters for rollout.bicep. No @secure()
// parameters exist on this template — it never touches Key Vault secret
// values, only the ROLLOUT_MODE env var and the two scheduler jobs'
// trigger type/cron wiring.
//
// Values marked REPLACE_WITH_ENVIRONMENT_OUTPUT_* must be copied from the
// environment.bicep deployment output for this resource group. Image
// digest values must match what release.bicep currently has deployed —
// this template does not ship new images.
//
// Production MUST default to disabled/Manual (ADR 0008 items 11-12).
// Promoting rolloutMode and/or a trigger type to Schedule is a separate,
// explicitly reviewed deploy of this template with different parameter
// values — never edit this committed default file to promote production;
// pass overrides via --parameters at deploy time instead, and keep this
// file's committed defaults disabled/manual.
using '../rollout.bicep'

param environmentName = 'prod'
param location = 'westus3'

param keyVaultName = 'kv-krypto-prod'
param containerAppsEnvironmentId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_containerAppsEnvironmentId'
param registryLoginServer = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_acrLoginServer'
param runtimeIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_runtimeIdentityId'
param runtimeIdentityClientId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_runtimeIdentityClientId'
param schedulerIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_schedulerIdentityId'

param webAppName = 'ca-prod-web'
param hourlyJobName = 'caj-prod-agent-run'
param dailyJobName = 'caj-prod-daily-summary'

// Must match the web image digest release.bicep currently has deployed —
// the hourly/daily scheduler jobs also run from this same image
// (Dockerfile `web` target contains scripts/scheduled-trigger.mjs).
param webImageName = 'krypto-web'
param imageDigest = 'sha256:REPLACE_WITH_CURRENTLY_RELEASED_DIGEST'

param azureFoundryProjectEndpoint = 'https://ghcp-foundry-eastus2.services.ai.azure.com/api/projects/krypto-prod-agents'
param azureFoundryAgentName = 'krypto-prod-decision'
param azureFoundryAgentVersion = '1'

// Forced-disable runs may execute before the agent-integrated image replaces
// the live pre-agent image. Preserve that image's startup contract without
// granting the new release a direct-model configuration.
param legacyDirectModelCompatibility = true
param legacyAzureOpenAIBaseUrl = 'https://ghcp-foundry-eastus2.openai.azure.com/openai/v1/'
param legacyAzureOpenAIDeploymentName = 'krypto-prod-luna'

param posthogHost = 'https://us.i.posthog.com'
param posthogEnvironment = 'prod'
param alertEmailTo = 'varun.sharma.exe@gmail.com'
param communicationEmailSender = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_communicationEmailSender'

// Production default. Do not change in this committed file — promote via
// an explicit, separately reviewed --parameters override instead.
param rolloutMode = 'disabled'
param hourlyTriggerType = 'Manual'
param dailyTriggerType = 'Manual'
param scheduleGenerationUnixSeconds = '0'
param tags = {
  project: 'project-krypto'
}
