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
param location = 'westus3'

param keyVaultName = 'kv-krypto-dev'
param containerAppsEnvironmentId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_containerAppsEnvironmentId'
param registryLoginServer = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_acrLoginServer'
param runtimeIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_runtimeIdentityId'
param runtimeIdentityClientId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_runtimeIdentityClientId'
param schedulerIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_schedulerIdentityId'

param webAppName = 'ca-dev-web'
param hourlyJobName = 'caj-dev-agent-run'
param dailyJobName = 'caj-dev-daily-summary'

// Must match the web image digest release.bicep currently has deployed —
// the hourly/daily scheduler jobs also run from this same image
// (Dockerfile `web` target contains scripts/scheduled-trigger.mjs).
param webImageName = 'krypto-web'
param imageDigest = 'sha256:REPLACE_WITH_CURRENTLY_RELEASED_DIGEST'
param releaseSha = 'REPLACE_WITH_REAL_COMMIT_SHA000000000000'

param azureFoundryProjectEndpoint = 'https://ghcp-foundry-eastus2.services.ai.azure.com/api/projects/krypto-dev-agents'
param azureFoundryAgentName = 'krypto-dev-decision'
param azureFoundryAgentVersion = '1'
param legacyDirectModelCompatibility = false

param posthogHost = 'https://us.i.posthog.com'
param posthogEnvironment = 'dev'
param alertEmailTo = 'varun.sharma.exe@gmail.com'
param safetyPrimaryOnCall = readEnvironmentVariable('SAFETY_PRIMARY_ON_CALL_DEV')
param safetyBackupOnCall = readEnvironmentVariable('SAFETY_BACKUP_ON_CALL_DEV')
param safetyReleaseOwner = readEnvironmentVariable('SAFETY_RELEASE_OWNER_DEV')
param safetyApprover = readEnvironmentVariable('SAFETY_APPROVER_DEV')
param safetyEvidenceCustodian = readEnvironmentVariable('SAFETY_EVIDENCE_CUSTODIAN_DEV')
param safetyRollbackOwner = readEnvironmentVariable('SAFETY_ROLLBACK_OWNER_DEV')
param safetyPrimaryOnCallPublicKey = readEnvironmentVariable('SAFETY_PRIMARY_ON_CALL_PUBLIC_KEY_DEV')
param safetyBackupOnCallPublicKey = readEnvironmentVariable('SAFETY_BACKUP_ON_CALL_PUBLIC_KEY_DEV')
param safetyReleaseOwnerPublicKey = readEnvironmentVariable('SAFETY_RELEASE_OWNER_PUBLIC_KEY_DEV')
param safetyApproverPublicKey = readEnvironmentVariable('SAFETY_APPROVER_PUBLIC_KEY_DEV')
param safetyEvidenceCustodianPublicKey = readEnvironmentVariable('SAFETY_EVIDENCE_CUSTODIAN_PUBLIC_KEY_DEV')
param safetyRollbackOwnerPublicKey = readEnvironmentVariable('SAFETY_ROLLBACK_OWNER_PUBLIC_KEY_DEV')
param communicationEmailSender = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_communicationEmailSender'

// Promotion surface. Change these deliberately, in their own reviewed
// deploy, to move dev out of the disabled/manual default.
param rolloutMode = 'disabled'
param hourlyTriggerType = 'Manual'
param dailyTriggerType = 'Manual'
param scheduleGenerationUnixSeconds = '0'
param tags = {
  project: 'project-krypto'
}
