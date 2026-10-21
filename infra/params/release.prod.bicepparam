// Nonsecret prod release parameters for release.bicep.
//
// Values marked REPLACE_WITH_ENVIRONMENT_OUTPUT_* must be copied from the
// corresponding `az deployment group show` output of the environment.bicep
// deployment for this resource group (see infra/README.md "Outputs"). They
// are not secrets, but they are resource IDs/names/URLs generated at
// deploy time, not invented here. evidenceContainerUrl specifically must
// be the bare HTTPS evidenceContainerUrl output (no credential/query
// string embedded) — see scripts/azure/lib/evidence-upload.ts.
//
// Every @secure() parameter (databaseUrl, directUrl, cronSecret,
// posthogApiKey, adminPassword, adminSessionSecret, runtimeDatabasePassword,
// deploymentApprovalSecret) is
// deliberately NOT set with a literal value. Each
// is resolved from an environment variable at deploy time via
// readEnvironmentVariable() with NO fallback default: a missing
// environment variable fails the deployment instead of silently
// overwriting Key Vault with a placeholder value. The deployment
// pipeline / operator shell must export the real secret into the named
// environment variable before running `az deployment group create`. For
// CI template-compile-only validation (az bicep build-params), export
// throwaway stub values for these environment variables in the shell
// invoking the CLI; never commit a stub value into this file.
//
// Release deploys to production always land with rolloutMode 'disabled'
// and both scheduler jobs' triggerType 'Manual' (release.bicep hardcodes
// these); rollout.bicep is the only template that may promote them.
using '../release.bicep'

param environmentName = 'prod'
param location = 'westus3'

param keyVaultName = 'kv-krypto-prod02'
param containerAppsEnvironmentId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_containerAppsEnvironmentId'
param registryLoginServer = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_acrLoginServer'
param runtimeIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_runtimeIdentityId'
param runtimeIdentityClientId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_runtimeIdentityClientId'
param runtimeIdentityPrincipalId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_runtimeIdentityPrincipalId'
param schedulerIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_schedulerIdentityId'
param schedulerIdentityPrincipalId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_schedulerIdentityPrincipalId'
param opsIdentityId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_opsIdentityId'
param opsIdentityPrincipalId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_opsIdentityPrincipalId'
param opsIdentityClientId = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_opsIdentityClientId'
param evidenceContainerUrl = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_evidenceContainerUrl'
param communicationServiceName = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_communicationServiceName'
param communicationEmailSender = 'REPLACE_WITH_ENVIRONMENT_OUTPUT_communicationEmailSender'

param webAppName = 'ca-prod-web'
param hourlyJobName = 'caj-prod-agent-run'
param dailyJobName = 'caj-prod-daily-summary'
param migrateInitJobName = 'caj-prod-migrate-init'
param preflightJobName = 'caj-prod-preflight'
param verifiedBackupJobName = 'caj-prod-verified-backup'
param targetSmokeJobName = 'caj-prod-target-smoke'
param activationCheckJobName = 'caj-prod-activation-check'

// Digest-pinned images. Replace with the actual pushed digests — never a
// mutable tag such as :latest. imageDigest is reused verbatim for the web
// app, the hourly/daily scheduler jobs (same image, Dockerfile `web`
// target), and the IMAGE_DIGEST env var passed to target-smoke/
// activation-check, so there is exactly one source of truth for "which
// release is this."
param webImageName = 'krypto-web'
param imageDigest = 'sha256:REPLACE_WITH_PUSHED_WEB_DIGEST'
param opsImageName = 'krypto-ops'
param opsImageDigest = 'sha256:REPLACE_WITH_PUSHED_OPS_DIGEST'

// The 40-character lowercase-hex git commit SHA that produced this
// release. Not invented here — must be the actual commit SHA being
// deployed.
param releaseSha = 'REPLACE_WITH_REAL_COMMIT_SHA000000000000'

param azureOpenAIBaseUrl = 'https://ai-krypto-westus3-02.openai.azure.com/openai/v1/'
param azureOpenAIDeploymentName = 'krypto-prod-luna'

param posthogHost = 'https://us.i.posthog.com'
param posthogEnvironment = 'prod'
param alertEmailTo = 'varun.sharma.exe@gmail.com'

// Fresh-deployment Azure PostgreSQL runtime login role name. Nonsecret —
// a role name, not a credential. Default matches the database
// workstream's krypto_app convention; override only if that workstream's
// reviewed configuration uses a different name for this environment.
param runtimeDatabaseLoginRole = 'krypto_app'

param databaseUrl = readEnvironmentVariable('DATABASE_URL_PROD')
param directUrl = readEnvironmentVariable('DIRECT_URL_PROD')
param cronSecret = readEnvironmentVariable('CRON_SECRET_PROD')
param posthogApiKey = readEnvironmentVariable('POSTHOG_API_KEY_PROD')
param adminPassword = readEnvironmentVariable('ADMIN_PASSWORD_PROD')
param adminSessionSecret = readEnvironmentVariable('ADMIN_SESSION_SECRET_PROD')
param runtimeDatabasePassword = readEnvironmentVariable('RUNTIME_DATABASE_PASSWORD_PROD')
// Mounted only on target-smoke and activation-check (see release.bicep).
// The prod workflows map the protected GitHub Environment secret named
// DEPLOYMENT_APPROVAL_SECRET to this internal _PROD variable.
param deploymentApprovalSecret = readEnvironmentVariable('DEPLOYMENT_APPROVAL_SECRET_PROD')

param tags = {
  project: 'project-krypto'
}
