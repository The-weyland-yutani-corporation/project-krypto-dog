// Per-environment resource-group-scoped template: networking, ACR, the
// Container Apps environment, PostgreSQL Flexible Server 17, Key Vault,
// evidence storage, monitoring, and the runtime/scheduler/ops managed
// identities with their stable (non-secret-dependent) RBAC. Deploy once
// per environment (dev, prod) into the resource group bootstrap.bicep
// created. Run after bootstrap.bicep, before release.bicep.
//
// Deploy with:
//   az deployment group create \
//     --resource-group <rg-from-bootstrap-output> \
//     --template-file infra/environment.bicep \
//     --parameters infra/params/environment.dev.bicepparam \
//     --parameters administratorLoginPassword=<supplied-at-deploy-time>
targetScope = 'resourceGroup'

@description('Short environment name: dev or prod. Drives resource naming and safety defaults (purge protection, delete locks, HA).')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Azure region for all resources.')
param location string

@description('Resource name prefix, e.g. krypto-dev or krypto-prod.')
param namePrefix string = 'krypto-${environmentName}'

@description('Globally unique Container Registry name (alphanumeric only).')
param acrName string

@description('Globally unique Key Vault name.')
param keyVaultName string

@description('Globally unique evidence storage account name (lowercase alphanumeric only).')
param evidenceStorageAccountName string

@description('Globally unique Azure Communication Services resource name.')
param communicationServiceName string

@description('Email Communication Service resource name.')
param emailServiceName string

@description('Principal IDs (object IDs) of the GitHub Actions OIDC deployment identities from bootstrap.bicep outputs that need read-only access to the evidence container, e.g. to download versioned ops-job reports with `az storage blob download --auth-mode login` from a CI/CD workflow. RG-scoped Contributor grants no storage data-plane access on its own (shared key access is disabled on the account), so this is the explicit data-plane grant those identities need. Pass the dev deploy identity principal ID for a dev environment, and both the prod-deploy and prod-promotion identity principal IDs for the prod environment.')
param evidenceReaderPrincipalIds array = []

@description('VNet address space (/24).')
param vnetAddressPrefix string = '10.20.0.0/24'

@description('Container Apps subnet address prefix (/27).')
param containerAppsSubnetPrefix string = '10.20.0.0/27'

@description('PostgreSQL delegated subnet address prefix (/27).')
param postgresSubnetPrefix string = '10.20.0.32/27'

@description('PostgreSQL administrator login name.')
param postgresAdministratorLogin string = 'krypto_owner'

@description('PostgreSQL administrator password. Supplied at deploy time; never committed or defaulted.')
@secure()
param postgresAdministratorLoginPassword string

@description('Initialize credentials for a fresh environment, or preserve them during an existing-release cutover so source ops jobs retain database access.')
@allowed([
  'initialize'
  'preserve'
])
param postgresCredentialMode string = 'initialize'

@description('Stage the existing ops direct-url binding only for a proven-new PostgreSQL/Key Vault foundation. Existing foundations keep their bindings unchanged.')
@allowed([
  'none'
  'initialize'
])
param bootstrapDatabaseAccessMode string = 'none'

@secure()
param bootstrapDirectUrl string = ''

@description('PostgreSQL compute SKU name.')
param postgresSkuName string = 'Standard_B1ms'

@description('PostgreSQL compute tier matching postgresSkuName.')
param postgresSkuTier string = 'Burstable'

@description('PostgreSQL storage size in GiB.')
param postgresStorageSizeGB int = 32

@description('PostgreSQL point-in-time-recovery backup retention in days.')
param postgresBackupRetentionDays int = 35

@description('Operator alert email addresses for the Action Group.')
param alertEmails array

@description('Time-based retention period, in days, for the evidence container\'s immutability (WORM) policy. Production must use >=35 days per the approved evidence-retention plan; development may use a shorter value. See modules/storage.bicep for exactly what this does and does not enforce (an unlocked policy already blocks blob overwrite/delete; only Bicep-declarable, never Bicep-lockable).')
@minValue(1)
@maxValue(146000)
param evidenceImmutabilityRetentionDays int = 35

@description('Tags applied to all resources.')
param tags object = {
  project: 'project-krypto'
}

var isProd = environmentName == 'prod'
var envTags = union(tags, { environment: environmentName })
var containerAppsEnvironmentName = 'cae-${namePrefix}'
var logAnalyticsWorkspaceName = 'log-${namePrefix}'
var actionGroupName = 'ag-${namePrefix}'
var postgresServerName = 'psql-${namePrefix}'
var runtimeIdentityName = 'id-${namePrefix}-runtime'
var schedulerIdentityName = 'id-${namePrefix}-scheduler'
var opsIdentityName = 'id-${namePrefix}-ops'
var hourlyJobName = 'caj-${environmentName}-agent-run'
var dailyJobName = 'caj-${environmentName}-daily-summary'

module network 'modules/network.bicep' = {
  name: 'network'
  params: {
    location: location
    namePrefix: namePrefix
    vnetAddressPrefix: vnetAddressPrefix
    containerAppsSubnetPrefix: containerAppsSubnetPrefix
    postgresSubnetPrefix: postgresSubnetPrefix
    tags: envTags
  }
}

module acr 'modules/acr.bicep' = {
  name: 'acr'
  params: {
    registryName: acrName
    location: location
    tags: envTags
  }
}

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  tags: envTags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    actionGroupName: actionGroupName
    actionGroupShortName: 'krypto${environmentName}'
    alertEmails: alertEmails
    logAnalyticsWorkspaceId: logAnalyticsWorkspace.id
    hourlyJobName: hourlyJobName
    dailyJobName: dailyJobName
    tags: envTags
  }
}

module containerAppsEnvironment 'modules/container-apps-environment.bicep' = {
  name: 'container-apps-environment'
  params: {
    environmentResourceName: containerAppsEnvironmentName
    location: location
    infrastructureSubnetId: network.outputs.containerAppsSubnetId
    logAnalyticsCustomerId: logAnalyticsWorkspace.properties.customerId
    logAnalyticsSharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
    tags: envTags
  }
}

module postgres 'modules/postgresql.bicep' = {
  name: 'postgres'
  params: {
    serverName: postgresServerName
    location: location
    delegatedSubnetId: network.outputs.postgresSubnetId
    privateDnsZoneId: network.outputs.postgresPrivateDnsZoneId
    administratorLogin: postgresAdministratorLogin
    administratorLoginPassword: postgresAdministratorLoginPassword
    preserveAdministratorPassword: postgresCredentialMode == 'preserve'
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    storageSizeGB: postgresStorageSizeGB
    backupRetentionDays: postgresBackupRetentionDays
    // Geo-redundant backup is creation-time-only and the approved plan
    // selects it for prod only; HA stays off in both (ADR 0008 item 8).
    geoRedundantBackupEnabled: isProd
    highAvailabilityEnabled: false
    enableDeleteLock: isProd
    tags: envTags
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  params: {
    vaultName: keyVaultName
    location: location
    enablePurgeProtection: isProd
    softDeleteRetentionInDays: 90
    enableDeleteLock: isProd
    tags: envTags
  }
}

module identities 'modules/identities.bicep' = {
  name: 'identities'
  params: {
    runtimeIdentityName: runtimeIdentityName
    schedulerIdentityName: schedulerIdentityName
    opsIdentityName: opsIdentityName
    location: location
    registryId: acr.outputs.registryId
    tags: envTags
  }
}

module bootstrapDatabaseAccess 'modules/ops-database-access.bicep' = if (bootstrapDatabaseAccessMode == 'initialize') {
  name: 'bootstrap-database-access'
  params: {
    keyVaultName: keyVault.outputs.vaultName
    opsIdentityPrincipalId: identities.outputs.opsIdentityPrincipalId
    writeSecret: true
    directUrl: bootstrapDirectUrl
  }
  dependsOn: [
    postgres
  ]
}

module evidenceStorage 'modules/storage.bicep' = {
  name: 'evidence-storage'
  params: {
    storageAccountName: evidenceStorageAccountName
    location: location
    enableDeleteLock: isProd
    evidenceReaderPrincipalIds: evidenceReaderPrincipalIds
    opsIdentityPrincipalId: identities.outputs.opsIdentityPrincipalId
    immutabilityRetentionDays: evidenceImmutabilityRetentionDays
    tags: envTags
  }
}

module communicationEmail 'modules/communication-email.bicep' = {
  name: 'communication-email'
  params: {
    communicationServiceName: communicationServiceName
    emailServiceName: emailServiceName
    tags: envTags
  }
}

output acrName string = acr.outputs.registryName
output acrLoginServer string = acr.outputs.registryLoginServer
output containerAppsEnvironmentId string = containerAppsEnvironment.outputs.environmentId
output containerAppsEnvironmentDefaultDomain string = containerAppsEnvironment.outputs.defaultDomain
output postgresServerName string = postgres.outputs.serverName
output postgresServerFqdn string = postgres.outputs.serverFqdn
output keyVaultName string = keyVault.outputs.vaultName
output keyVaultUri string = keyVault.outputs.vaultUri
output evidenceStorageAccountName string = evidenceStorage.outputs.storageAccountName
output evidenceContainerName string = evidenceStorage.outputs.evidenceContainerName
// Full bare HTTPS evidence container URL (release.bicep's
// EVIDENCE_CONTAINER_URL input) — not just the account/container names,
// so no template has to reconstruct the URL itself.
output evidenceContainerUrl string = evidenceStorage.outputs.evidenceContainerUrl
// The retention period actually deployed on the evidence container's
// immutability policy, for operator verification before performing the
// manual, irreversible lock step described in modules/storage.bicep.
output evidenceImmutabilityRetentionDays int = evidenceStorage.outputs.immutabilityRetentionDays
output communicationServiceId string = communicationEmail.outputs.communicationServiceId
output communicationServiceName string = communicationEmail.outputs.communicationServiceName
output communicationServiceEndpoint string = communicationEmail.outputs.communicationServiceEndpoint
output communicationEmailSender string = communicationEmail.outputs.communicationEmailSender
output logAnalyticsWorkspaceId string = logAnalyticsWorkspace.id
output actionGroupId string = monitoring.outputs.actionGroupId
output failedJobExecutionAlertId string = monitoring.outputs.failedJobExecutionAlertId
output failedJobExecutionAlertName string = monitoring.outputs.failedJobExecutionAlertName
output vnetId string = network.outputs.vnetId
output containerAppsSubnetId string = network.outputs.containerAppsSubnetId
output runtimeIdentityId string = identities.outputs.runtimeIdentityId
output runtimeIdentityClientId string = identities.outputs.runtimeIdentityClientId
output runtimeIdentityPrincipalId string = identities.outputs.runtimeIdentityPrincipalId
output schedulerIdentityId string = identities.outputs.schedulerIdentityId
output schedulerIdentityClientId string = identities.outputs.schedulerIdentityClientId
output schedulerIdentityPrincipalId string = identities.outputs.schedulerIdentityPrincipalId
output opsIdentityId string = identities.outputs.opsIdentityId
output opsIdentityClientId string = identities.outputs.opsIdentityClientId
output opsIdentityPrincipalId string = identities.outputs.opsIdentityPrincipalId
