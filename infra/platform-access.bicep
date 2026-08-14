// Resource-group-scoped workload binding template for the existing dedicated
// Project Krypto Foundry account. It grants only Cognitive Services OpenAI
// User at account scope to the identities that call inference directly:
// runtime and ops in each environment. Schedulers call the application and
// therefore receive no direct Foundry role.
//
// Role assignment names use account scope + principal ID + role definition
// as GUID seeds, making repeated deployments stable and idempotent.
//
// Deploy after both environment.bicep deployments have produced their
// runtimeIdentityPrincipalId and opsIdentityPrincipalId outputs:
//   az deployment group create \
//     --resource-group rg-krypto-platform \
//     --template-file infra/platform-access.bicep \
//     --parameters infra/params/platform-access.bicepparam
targetScope = 'resourceGroup'

@description('Name of the existing dedicated Microsoft Foundry account.')
@allowed([
  'ai-krypto-westus3'
])
param foundryAccountName string = 'ai-krypto-westus3'

@description('Dev runtime managed identity principal ID.')
param devRuntimePrincipalId string

@description('Dev ops managed identity principal ID.')
param devOpsPrincipalId string

@description('Prod runtime managed identity principal ID.')
param prodRuntimePrincipalId string

@description('Prod ops managed identity principal ID.')
param prodOpsPrincipalId string

// Cognitive Services OpenAI User: inference data-plane access without
// account/model management or role-assignment privileges.
var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}

resource devRuntimeOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, devRuntimePrincipalId, cognitiveServicesOpenAiUserRoleId)
  properties: {
    principalId: devRuntimePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
  }
}

resource devOpsOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, devOpsPrincipalId, cognitiveServicesOpenAiUserRoleId)
  properties: {
    principalId: devOpsPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
  }
}

resource prodRuntimeOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, prodRuntimePrincipalId, cognitiveServicesOpenAiUserRoleId)
  properties: {
    principalId: prodRuntimePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
  }
}

resource prodOpsOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, prodOpsPrincipalId, cognitiveServicesOpenAiUserRoleId)
  properties: {
    principalId: prodOpsPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
  }
}

output foundryAccountId string = foundryAccount.id
output cognitiveServicesOpenAiUserRoleDefinitionId string = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  cognitiveServicesOpenAiUserRoleId
)
