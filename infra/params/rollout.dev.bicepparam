// Nonsecret dev rollout parameters for rollout.bicep. No @secure()
// parameters exist on this template — it never touches Key Vault secret
// values, only the ROLLOUT_MODE env var and the two scheduler jobs'
// trigger type/cron wiring.
//
// Values marked REPLACE_WITH_ENVIRONMENT_OUTPUT_* must be copied from the
// environment.bicep deployment output for this resource group. Image
// digest values must match what release.bicep currently has deployed —
// this template does not ship new images.
//
// Dev may promote here directly; still defaults to disabled/Manual so an
// unreviewed deploy does not silently enable trading or schedules.
using '../rollout.bicep'

param environmentName = 'dev'
param location = 'eastus2'

param keyVaultName = 'kv-krypto-dev'
param containerAppsEnvironmentId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_containerAppsEnvironmentId'
param registryLoginServer = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_acrLoginServer'
param runtimeIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_runtimeIdentityId'
param schedulerIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_schedulerIdentityId'

param webAppName = 'ca-dev-web'
param hourlyJobName = 'caj-dev-agent-run'
param dailyJobName = 'caj-dev-daily-summary'

// Must match the web image digest release.bicep currently has deployed —
// the hourly/daily scheduler jobs also run from this same image
// (Dockerfile `web` target contains scripts/scheduled-trigger.mjs).
param webImageName = 'krypto-web'
param imageDigest = 'sha256:REPLACE_WITH_CURRENTLY_RELEASED_DIGEST'

param anthropicFoundryBaseUrl = 'https://REPLACE_WITH_FOUNDRY_RESOURCE.services.ai.azure.com/anthropic'
param anthropicFoundryDeployment = 'krypto-dev-claude'
param anthropicFoundryApiVersion = '2024-10-21'

param posthogHost = 'https://us.i.posthog.com'
param alertEmailTo = 'ops-dev@example.com'
param alertEmailFrom = 'krypto-dev@example.com'

// Promotion surface. Change these deliberately, in their own reviewed
// deploy, to move dev out of the disabled/manual default.
param rolloutMode = 'disabled'
param hourlyTriggerType = 'Manual'
param dailyTriggerType = 'Manual'

param tags = {
  project: 'project-krypto'
}
