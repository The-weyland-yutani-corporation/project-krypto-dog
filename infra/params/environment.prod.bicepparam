// Nonsecret prod environment parameters for environment.bicep. ACR/Key
// Vault/storage account names must be globally unique — replace the
// placeholders below with unique values before deploying.
//
// postgresAdministratorLoginPassword is intentionally NOT set here: it is
// a @secure() parameter with no default. Supply it at deploy time via
// --parameters postgresAdministratorLoginPassword=<value>, or export the
// POSTGRES_ADMIN_PASSWORD_PROD environment variable before deploying (see
// below). readEnvironmentVariable() below has no fallback default — a
// missing environment variable fails the deployment instead of silently
// overwriting Key Vault/Postgres with a placeholder value. For CI
// template-compile-only validation (az bicep build-params), export a
// throwaway stub value for POSTGRES_ADMIN_PASSWORD_PROD in the shell
// invoking the CLI; never commit a stub value into this file.
using '../environment.bicep'

param environmentName = 'prod'
param location = 'eastus2'
param namePrefix = 'krypto-prod'

param acrName = 'acrkryptoprod'
param keyVaultName = 'kv-krypto-prod'
param evidenceStorageAccountName = 'stkryptoprodevid'

// Principal IDs of the "production-deploy" and "production-promotion"
// GitHub Environments' OIDC deployment identities (bootstrap.bicep
// outputs prodDeployIdentityPrincipalId and
// prodPromotionIdentityPrincipalId). Grants both identities read-only
// (Storage Blob Data Reader) access to the evidence container so CI/CD
// workflows in either environment can download versioned ops-job reports
// with `az storage blob download --auth-mode login` — RG Contributor
// alone grants no data-plane access since shared key access is disabled.
// Replace both with the actual values after running bootstrap.bicep once.
param evidenceReaderPrincipalIds = [
  'REPLACE_WITH_BOOTSTRAP_PROD_DEPLOY_IDENTITY_PRINCIPAL_ID'
  'REPLACE_WITH_BOOTSTRAP_PROD_PROMOTION_IDENTITY_PRINCIPAL_ID'
]

param vnetAddressPrefix = '10.20.1.0/24'
param containerAppsSubnetPrefix = '10.20.1.0/27'
param postgresSubnetPrefix = '10.20.1.32/27'

param postgresAdministratorLogin = 'krypto_owner'
param postgresAdministratorLoginPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD_PROD')
// Production sizing should be reviewed and raised from the dev-equivalent
// Burstable default before go-live; ADR 0008 item 8 accepts single-zone
// only with 35-day PITR as the interim posture.
param postgresSkuName = 'Standard_D2ds_v5'
param postgresSkuTier = 'GeneralPurpose'
param postgresStorageSizeGB = 64
param postgresBackupRetentionDays = 35

param alertEmails = [
  'ops@example.com'
]

// Approved evidence-retention plan requires >=35 days in production.
// This template can only create/extend an UNLOCKED policy at this
// retention period; a reviewer/operator must separately run the
// one-time, irreversible `az storage container immutability-policy lock`
// (or equivalent REST call) after this deploys -- see the "Evidence
// container immutability" comment in modules/storage.bicep for exactly
// what is and is not enforced before that manual step.
param evidenceImmutabilityRetentionDays = 90

param tags = {
  project: 'project-krypto'
}
