// Nonsecret dev environment parameters for environment.bicep. ACR/Key
// Vault/storage account names must be globally unique — replace the
// placeholders below with unique values before deploying.
//
// postgresAdministratorLoginPassword is intentionally NOT set here: it is
// a @secure() parameter with no default. Supply it at deploy time via
// --parameters postgresAdministratorLoginPassword=<value>, or export the
// POSTGRES_ADMIN_PASSWORD_DEV environment variable before deploying (see
// below). readEnvironmentVariable() below has no fallback default — a
// missing environment variable fails the deployment instead of silently
// overwriting Key Vault/Postgres with a placeholder value. For CI
// template-compile-only validation (az bicep build-params), export a
// throwaway stub value for POSTGRES_ADMIN_PASSWORD_DEV in the shell
// invoking the CLI; never commit a stub value into this file.
using '../environment.bicep'

param environmentName = 'dev'
param location = 'westus3'
param namePrefix = 'krypto-dev'

param acrName = 'acrkryptodev'
param keyVaultName = 'kv-krypto-dev'
param evidenceStorageAccountName = 'stkryptodevevid'
param communicationServiceName = 'acs-krypto-dev'
param emailServiceName = 'email-krypto-dev'

// Principal ID of the "development" GitHub Environment's OIDC deployment
// identity (bootstrap.bicep output devIdentityPrincipalId). Grants that
// identity read-only (Storage Blob Data Reader) access to the evidence
// container so a CI/CD workflow can download versioned ops-job reports
// with `az storage blob download --auth-mode login` — RG Contributor
// alone grants no data-plane access since shared key access is disabled.
// Replace with the actual value after running bootstrap.bicep once.
param evidenceReaderPrincipalIds = [
  'REPLACE_WITH_BOOTSTRAP_DEV_IDENTITY_PRINCIPAL_ID'
]

param vnetAddressPrefix = '10.20.0.0/24'
param containerAppsSubnetPrefix = '10.20.0.0/27'
param postgresSubnetPrefix = '10.20.0.32/27'

param postgresAdministratorLogin = 'krypto_owner'
param postgresAdministratorLoginPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD_DEV')
param postgresSkuName = 'Standard_B1ms'
param postgresSkuTier = 'Burstable'
param postgresStorageSizeGB = 32
param postgresBackupRetentionDays = 35

param alertEmails = [
  'varun.sharma.exe@gmail.com'
]

// Dev may keep evidence in an immutability-protected state for a much
// shorter window than production, and this file never locks the policy
// (locking is a manual, one-time, irreversible follow-up step performed
// outside of any template -- see modules/storage.bicep). Any positive
// value already blocks overwrite/delete for its retention window.
param evidenceImmutabilityRetentionDays = 7

param tags = {
  project: 'project-krypto'
}
