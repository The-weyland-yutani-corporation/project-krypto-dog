targetScope = 'resourceGroup'

param keyVaultName string
param opsIdentityPrincipalId string

@description('Write the supplied binding only during an admitted creation or release; false preserves the existing secret.')
param writeSecret bool

@secure()
param directUrl string

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource existingDirectUrl 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'direct-url'
}

resource directUrlSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (writeSecret) {
  parent: keyVault
  name: 'direct-url'
  properties: {
    value: directUrl
  }
}

// Preserve the release template's exact assignment ID, principal and scope.
resource opsDirectUrlAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'direct-url', opsIdentityPrincipalId, 'ops')
  scope: existingDirectUrl
  properties: {
    principalId: opsIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
  dependsOn: [
    directUrlSecret
  ]
}
