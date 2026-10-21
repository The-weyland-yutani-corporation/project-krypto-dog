// Resource-group-scoped model template for the dedicated Project Krypto
// Microsoft Foundry account. Account lifecycle is deliberately separate in
// platform-account.bicep: this template references the account as existing
// and owns only the reviewed dev/prod model deployments beneath it.
//
// Every model setting is pinned to the approved
// OpenAI/gpt-5.6-luna/2026-07-09 GlobalStandard configuration. The
// single-value @allowed contracts ensure an operator cannot substitute a
// merely similar model, version, SKU, deployment name, or capacity without a
// reviewed source change.
//
// Deploy with:
//   az deployment group create \
//     --resource-group rg-krypto-platform \
//     --template-file infra/platform.bicep \
//     --parameters infra/params/platform.bicepparam
targetScope = 'resourceGroup'

@description('Name of the existing dedicated Microsoft Foundry / Cognitive Services account. Created separately by platform-account.bicep.')
@allowed([
  'ai-krypto-westus3'
  'ai-krypto-westus3-02'
])
param foundryAccountName string = 'ai-krypto-westus3'

@description('Protected platform GitHub OIDC principal used for attended no-trade model smoke after deployment.')
param platformSmokePrincipalId string

@description('Pinned dev model deployment name.')
@allowed([
  'krypto-dev-luna'
])
param devDeploymentName string = 'krypto-dev-luna'

@description('Pinned dev model publisher format.')
@allowed([
  'OpenAI'
])
param devModelFormat string = 'OpenAI'

@description('Pinned dev model name.')
@allowed([
  'gpt-5.6-luna'
])
param devModelName string = 'gpt-5.6-luna'

@description('Pinned dev model version, exactly as published by the provider.')
@allowed([
  '2026-07-09'
])
param devModelVersion string = '2026-07-09'

@description('Pinned dev deployment SKU name.')
@allowed([
  'GlobalStandard'
])
param devSkuName string = 'GlobalStandard'

@description('Pinned dev deployment capacity in the provider-defined GlobalStandard unit.')
@allowed([
  10
])
param devSkuCapacity int = 10

@description('Pinned prod model deployment name.')
@allowed([
  'krypto-prod-luna'
])
param prodDeploymentName string = 'krypto-prod-luna'

@description('Pinned prod model publisher format.')
@allowed([
  'OpenAI'
])
param prodModelFormat string = 'OpenAI'

@description('Pinned prod model name.')
@allowed([
  'gpt-5.6-luna'
])
param prodModelName string = 'gpt-5.6-luna'

@description('Pinned prod model version, exactly as published by the provider.')
@allowed([
  '2026-07-09'
])
param prodModelVersion string = '2026-07-09'

@description('Pinned prod deployment SKU name.')
@allowed([
  'GlobalStandard'
])
param prodSkuName string = 'GlobalStandard'

@description('Pinned prod deployment capacity in the provider-defined GlobalStandard unit.')
@allowed([
  10
])
param prodSkuCapacity int = 10

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}

var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource platformSmokeOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, platformSmokePrincipalId, cognitiveServicesOpenAiUserRoleId)
  properties: {
    principalId: platformSmokePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
  }
}

resource devDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundryAccount
  name: devDeploymentName
  sku: {
    name: devSkuName
    capacity: devSkuCapacity
  }
  properties: {
    model: {
      format: devModelFormat
      name: devModelName
      version: devModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource prodDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundryAccount
  name: prodDeploymentName
  sku: {
    name: prodSkuName
    capacity: prodSkuCapacity
  }
  properties: {
    model: {
      format: prodModelFormat
      name: prodModelName
      version: prodModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  // Cognitive Services rejects concurrent child-deployment mutations on one
  // account. Serialize prod after dev instead of racing the parent resource.
  dependsOn: [
    devDeployment
  ]
}

output foundryAccountEndpoint string = foundryAccount.properties.endpoint
output devDeploymentName string = devDeployment.name
output prodDeploymentName string = prodDeployment.name
