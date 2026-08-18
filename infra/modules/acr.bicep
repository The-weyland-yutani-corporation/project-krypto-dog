// Per-environment Basic-tier Azure Container Registry. Admin user is
// disabled; pulls are authorized exclusively through AcrPull role
// assignments granted to workload managed identities (see identities.bicep
// and environment.bicep).
targetScope = 'resourceGroup'

@description('Globally unique ACR name (alphanumeric only, 5-50 chars).')
@minLength(5)
@maxLength(50)
param registryName string

@description('Azure region for the registry.')
param location string

@description('Tags applied to the registry.')
param tags object = {}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

output registryId string = registry.id
output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
