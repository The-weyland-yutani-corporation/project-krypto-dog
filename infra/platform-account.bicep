// Resource-group-scoped lifecycle template for the dedicated Project Krypto
// Microsoft Foundry account. Model deployments are intentionally absent:
// platform.bicep owns them independently so account lifecycle and model
// rollout remain separate review/deployment operations.
//
// The inference endpoint is public at the network layer, but local/API-key
// authentication is disabled. Agent workload authorization is granted
// separately and narrowly at project scope by foundry-agents.bicep.
//
// Deploy this one-time lifecycle template with the bootstrap operator:
// Contributor plus Role Based Access Control Administrator can create the
// account but cannot create Microsoft.Authorization/locks. The caller also
// needs locks/write (for example, Owner) to establish the required delete
// lock. Routine platform OIDC deploys do not need that additional privilege.
//
// Deploy with:
//   az deployment group create \
//     --resource-group rg-krypto-platform \
//     --template-file infra/platform-account.bicep \
//     --parameters infra/params/platform-account.bicepparam
targetScope = 'resourceGroup'

@description('Approved Azure region for the dedicated Foundry account.')
@allowed([
  'westus3'
])
param location string = 'westus3'

@description('Globally unique account and custom subdomain name.')
@allowed([
  'ai-krypto-westus3'
])
param foundryAccountName string = 'ai-krypto-westus3'

@description('Tags applied to the dedicated Foundry account.')
param tags object = {
  project: 'project-krypto'
  component: 'foundry-platform'
  environment: 'shared'
  managedBy: 'bicep'
}

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: foundryAccountName
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  tags: tags
  properties: {
    customSubDomainName: foundryAccountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource foundryAccountDeleteLock 'Microsoft.Authorization/locks@2020-05-01' = {
  scope: foundryAccount
  name: 'protect-foundry-account'
  properties: {
    level: 'CanNotDelete'
    notes: 'Protect the dedicated Project Krypto Foundry account from accidental deletion.'
  }
}

output foundryAccountId string = foundryAccount.id
output foundryAccountName string = foundryAccount.name
output foundryAccountEndpoint string = foundryAccount.properties.endpoint
