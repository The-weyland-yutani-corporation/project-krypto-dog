// Per-environment user-assigned managed identities used by application
// workloads (not the GitHub OIDC deployment identities from bootstrap.bicep).
//
// - runtime:   the web Container App.
// - scheduler: the hourly/daily Container Apps Jobs. Only ever needs the
//              cron secret, never database or storage credentials.
// - ops:       the manually-triggered operations job (migrations, backup
//              restore verification, target smoke, rotation follow-up).
//
// RBAC assigned here is limited to what does not depend on resources
// created elsewhere (ACR pulls only). The ops identity's evidence-container
// write access (Storage Blob Data Contributor, container-scoped) is
// assigned in modules/storage.bicep instead, alongside the container it
// targets -- this identities module has no dependency on storage.bicep, so
// environment.bicep can create identities first and pass the ops
// identity's principal ID into storage.bicep, without a circular module
// dependency in either direction. Per-secret Key Vault RBAC is assigned in
// release.bicep once the secrets exist, so each identity is scoped to
// exactly the secrets it needs.
targetScope = 'resourceGroup'

@description('Runtime (web) identity name.')
param runtimeIdentityName string

@description('Scheduler (hourly/daily jobs) identity name.')
param schedulerIdentityName string

@description('Ops (manual operations job) identity name.')
param opsIdentityName string

@description('Azure region.')
param location string

@description('Container Registry resource ID that all three identities may pull images from.')
param registryId string

@description('Tags applied to the identities.')
param tags object = {}

var acrPullRoleId = '7f951dda-4ed3-4680-a904-db6ba5628e46'

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: runtimeIdentityName
  location: location
  tags: tags
}

resource schedulerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: schedulerIdentityName
  location: location
  tags: tags
}

resource opsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: opsIdentityName
  location: location
  tags: tags
}

resource registryRef 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: last(split(registryId, '/'))
}

resource runtimeAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registryId, runtimeIdentity.id, acrPullRoleId)
  scope: registryRef
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

resource schedulerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registryId, schedulerIdentity.id, acrPullRoleId)
  scope: registryRef
  properties: {
    principalId: schedulerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

resource opsAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registryId, opsIdentity.id, acrPullRoleId)
  scope: registryRef
  properties: {
    principalId: opsIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

output runtimeIdentityId string = runtimeIdentity.id
output runtimeIdentityPrincipalId string = runtimeIdentity.properties.principalId
output runtimeIdentityClientId string = runtimeIdentity.properties.clientId
output schedulerIdentityId string = schedulerIdentity.id
output schedulerIdentityPrincipalId string = schedulerIdentity.properties.principalId
output schedulerIdentityClientId string = schedulerIdentity.properties.clientId
output opsIdentityId string = opsIdentity.id
output opsIdentityPrincipalId string = opsIdentity.properties.principalId
output opsIdentityClientId string = opsIdentity.properties.clientId
