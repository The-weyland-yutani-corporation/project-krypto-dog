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
param location = 'eastus2'

param keyVaultName = 'kv-krypto-prod'
param containerAppsEnvironmentId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_containerAppsEnvironmentId'
param registryLoginServer = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_acrLoginServer'
param runtimeIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_runtimeIdentityId'
param schedulerIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_schedulerIdentityId'

param webAppName = 'ca-prod-web'
param hourlyJobName = 'caj-prod-agent-run'
param dailyJobName = 'caj-prod-daily-summary'

// Must match the web image digest release.bicep currently has deployed —
// the hourly/daily scheduler jobs also run from this same image
// (Dockerfile `web` target contains scripts/scheduled-trigger.mjs).
param webImageName = 'krypto-web'
param imageDigest = 'sha256:REPLACE_WITH_CURRENTLY_RELEASED_DIGEST'

param anthropicFoundryBaseUrl = 'https://REPLACE_WITH_FOUNDRY_RESOURCE.services.ai.azure.com/anthropic'
param anthropicFoundryDeployment = 'krypto-prod-claude'
param anthropicFoundryApiVersion = '2024-10-21'

param posthogHost = 'https://us.i.posthog.com'
param alertEmailTo = 'ops@example.com'
param alertEmailFrom = 'krypto@example.com'

// Production default. Do not change in this committed file — promote via
// an explicit, separately reviewed --parameters override instead.
param rolloutMode = 'disabled'
param hourlyTriggerType = 'Manual'
param dailyTriggerType = 'Manual'

param tags = {
  project: 'project-krypto'
}
