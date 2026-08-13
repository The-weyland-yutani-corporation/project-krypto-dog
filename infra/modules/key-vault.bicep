// Per-environment Key Vault. RBAC authorization only (no legacy access
// policies), soft-delete always on, purge protection enabled for
// production. Production also gets a CanNotDelete resource lock. Secret
// values themselves are created later by release.bicep, not here.
targetScope = 'resourceGroup'

@description('Key Vault name (must be globally unique, 3-24 chars).')
@minLength(3)
@maxLength(24)
param vaultName string

@description('Azure region.')
param location string

@description('Microsoft Entra tenant ID that owns the vault.')
param tenantId string = subscription().tenantId

@description('Enable purge protection. Required for production; irreversible once enabled.')
param enablePurgeProtection bool = false

@description('Soft-delete retention in days.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int = 90

@description('Apply a CanNotDelete resource lock (production only).')
param enableDeleteLock bool = false

@description('Tags applied to the vault.')
param tags object = {}

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: enablePurgeProtection ? true : null
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource deleteLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableDeleteLock) {
  scope: vault
  name: '${vaultName}-delete-lock'
  properties: {
    level: 'CanNotDelete'
    notes: 'Production Key Vault holds runtime/scheduler/ops secrets; delete requires removing this lock first.'
  }
}

output vaultId string = vault.id
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
