// Per-environment evidence Blob storage: no anonymous/public blob access,
// container + blob versioning, container + blob soft delete, and a
// time-based immutability (WORM) policy on the evidence container (ADR
// 0008 items 9-10). Production gets a CanNotDelete resource lock.
targetScope = 'resourceGroup'

@description('Storage account name (must be globally unique, lowercase alphanumeric, 3-24 chars).')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Azure region.')
param location string

@description('Evidence container name.')
param evidenceContainerName string = 'evidence'

@description('Blob/container soft-delete retention in days.')
@minValue(7)
@maxValue(365)
param softDeleteRetentionDays int = 30

@description('Apply a CanNotDelete resource lock (production only).')
param enableDeleteLock bool = false

@description('Principal IDs (object IDs) of the GitHub Actions OIDC deployment identities from bootstrap.bicep that need read-only access to the evidence container, e.g. to download versioned ops-job reports with `az storage blob download --auth-mode login`. Shared key access is disabled on this account, so RG-level Contributor alone grants no data-plane access — these principals need an explicit data-plane role. Granted read-only (Storage Blob Data Reader); never write/delete. Typically the dev deploy identity for a dev environment, and both the prod-deploy and prod-promotion identities for the prod environment.')
param evidenceReaderPrincipalIds array = []

@description('Principal ID (object ID) of the per-environment ops managed identity (environment.bicep\'s identities module output opsIdentityPrincipalId). Granted Storage Blob Data Contributor scoped to the evidence CONTAINER only (not the storage account), so the ops identity can read/write/delete blobs it owns inside this one container but has no access to any other container that might exist on this account and no control-plane rights over the storage account itself. Passed in rather than created here to avoid a circular module dependency: this module creates the container the assignment targets, while the ops identity itself is created in modules/identities.bicep.')
param opsIdentityPrincipalId string

@description('Time-based retention period, in days, for the evidence container\'s immutability (WORM) policy. While in effect, Azure blocks blob overwrite/delete for every principal -- including the ops identity above -- regardless of whether the policy is locked (see "Evidence container immutability" comment below). Azure\'s own floor is 1 day; the approved evidence-retention plan requires production to use >=35 days. Development may use a shorter value. Once a container-level policy is locked, its retention period can only be increased (never decreased), so choose an initial production value deliberately.')
@minValue(1)
@maxValue(146000)
param immutabilityRetentionDays int = 35

@description('Tags applied to the storage account.')
param tags object = {}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    accessTier: 'Cool'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: softDeleteRetentionDays
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: softDeleteRetentionDays
    }
  }
}

resource evidenceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: evidenceContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Built-in "Storage Blob Data Reader" role: read/list only, no
// write/delete/set-permission data actions. Scoped to the evidence
// container resource (not the whole storage account), so each granted
// principal can only read blobs already inside this one container.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

resource evidenceReaderAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in evidenceReaderPrincipalIds: {
    name: guid(evidenceContainer.id, principalId, storageBlobDataReaderRoleId)
    scope: evidenceContainer
    properties: {
      principalId: principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    }
  }
]

// Built-in "Storage Blob Data Contributor" role: read/write/delete blob
// data. Scoped to the evidence container resource (not the whole storage
// account, unlike the pre-refactor version of this grant), so the ops
// identity has no access to -- and cannot even enumerate -- any other
// container that might exist on this storage account in the future.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource opsContainerContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(evidenceContainer.id, opsIdentityPrincipalId, storageBlobDataContributorRoleId)
  scope: evidenceContainer
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataContributorRoleId
    )
  }
}

// Evidence container immutability (time-based retention / WORM).
//
// This resource can only create or extend an UNLOCKED time-based
// retention policy: the ImmutabilityPolicyProperty schema exposes only
// `immutabilityPeriodSinceCreationInDays` and the
// `allowProtectedAppendWrites*` flags -- there is no "locked" property to
// set declaratively. Locking a policy is a separate, one-time REST POST
// action (`.../immutabilityPolicies/default/lock`, e.g.
// `az storage container immutability-policy lock`), not an ARM/Bicep
// resource property, so no Bicep template -- this one included -- can
// lock a policy as part of a `deployment group create`. Locking
// production's policy is therefore a required manual follow-up step,
// performed once outside of any template in this tree, after this
// template has created the unlocked policy at the desired retention
// period.
//
// This limitation does not weaken the protection this ticket asks for:
// per Microsoft's documentation
// (https://learn.microsoft.com/azure/storage/blobs/immutable-storage-overview),
// "[w]hen a time-based retention policy is set, clients can create and
// read blobs, but can't modify or delete them" -- and this statement is
// true for BOTH locked and unlocked policies. So the moment this resource
// is deployed, the ops identity (like every other principal, including a
// subscription Owner) already cannot overwrite or delete a blob still
// inside its retention window, whether or not anyone has locked the
// policy yet. Locking only changes two things: (1) the policy itself can
// no longer be shortened or deleted -- an unlocked policy could still be
// weakened by a principal with Microsoft.Storage/storageAccounts/
// blobServices/containers/immutabilityPolicies/* control-plane rights,
// which the ops identity's Storage Blob Data Contributor role above does
// NOT grant (that role's control-plane actions are limited to
// containers/read|write|delete, not the immutabilityPolicies child
// resource); and (2) once locked, the retention period can only be
// increased (up to five times at the container level), never decreased,
// and the container itself can only be deleted once it is empty.
//
// Irreversibility: locking a time-based retention policy cannot be
// undone. Treat the manual lock step as a deliberate, audited,
// one-time production action -- not something to script casually or
// repeat per deployment.
resource evidenceImmutabilityPolicy 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = {
  parent: evidenceContainer
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: immutabilityRetentionDays
    allowProtectedAppendWrites: false
  }
}

resource deleteLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableDeleteLock) {
  scope: storageAccount
  name: '${storageAccountName}-delete-lock'
  properties: {
    level: 'CanNotDelete'
    notes: 'Production evidence storage holds backup/restore-verification and smoke evidence; delete requires removing this lock first.'
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output evidenceContainerName string = evidenceContainer.name
output primaryBlobEndpoint string = storageAccount.properties.primaryEndpoints.blob
// Full bare HTTPS container URL, no credentials/query string/fragment —
// this is exactly the EVIDENCE_CONTAINER_URL contract validated by
// scripts/azure/lib/evidence-upload.ts (managed-identity auth only, never a
// SAS token or key embedded in the URL). primaryEndpoints.blob is always
// returned by Azure with a trailing slash, so simple concatenation with the
// container name (no separator) yields exactly one slash between them.
output evidenceContainerUrl string = '${storageAccount.properties.primaryEndpoints.blob}${evidenceContainer.name}'
output immutabilityRetentionDays int = immutabilityRetentionDays
