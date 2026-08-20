// Resource-group-scoped workload binding template for one of the two reviewed
// Project Krypto Foundry targets. Deploy this file in the selected account's
// resource group. The account name is allowlisted, and the existing account is
// resolved in the actual deployment scope, so a wrong resource group fails
// instead of silently targeting another account.
//
// It grants only Cognitive Services OpenAI User at account scope to the
// four fixed UAMIs that call inference directly: runtime and ops in each
// environment. The protected verification workflow independently resolves the
// two fixed scheduler UAMIs and requires that they have no Foundry role.
//
// Role assignment names use account scope + fixed UAMI resource ID + role
// definition as GUID seeds, making repeated deployments stable and idempotent.
//
// The operational target is applied only by an authorized human using an
// interactive Azure CLI login. GitHub OIDC may apply only the dedicated target
// and may verify either target with read-only access.
//
// Deploy only after both environment.bicep foundations have created the six
// fixed UAMIs:
//   az deployment group create \
//     --resource-group ghcp-foundry-models \
//     --template-file infra/platform-access/main.bicep \
//     --parameters infra/params/platform-access.bicepparam
targetScope = 'resourceGroup'

@description('Name of an approved existing Microsoft Foundry account. Deploy only in that account\'s reviewed resource group.')
@allowed([
  'ghcp-foundry-eastus2'
  'ai-krypto-westus3'
])
param foundryAccountName string = 'ghcp-foundry-eastus2'

var devResourceGroupName = 'rg-krypto-dev'
var prodResourceGroupName = 'rg-krypto-prod'

resource devRuntimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  scope: resourceGroup(devResourceGroupName)
  name: 'id-krypto-dev-runtime'
}

resource devOpsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  scope: resourceGroup(devResourceGroupName)
  name: 'id-krypto-dev-ops'
}

resource prodRuntimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  scope: resourceGroup(prodResourceGroupName)
  name: 'id-krypto-prod-runtime'
}

resource prodOpsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  scope: resourceGroup(prodResourceGroupName)
  name: 'id-krypto-prod-ops'
}

// Cognitive Services OpenAI User: inference data-plane access without
// account/model management or role-assignment privileges.
var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

@description('Cognitive Services OpenAI User built-in role.')
resource cognitiveServicesOpenAiUserRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: cognitiveServicesOpenAiUserRoleId
}

// This existing resource is intentionally resolved in the actual deployment
// resource group. A cross-combined account/resource-group invocation cannot
// resolve the reviewed existing account and fails before role assignment.
resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}

resource devRuntimeOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, devRuntimeIdentity.id, cognitiveServicesOpenAiUserRoleId)
  properties: {
    principalId: devRuntimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: cognitiveServicesOpenAiUserRole.id
  }
}

resource devOpsOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, devOpsIdentity.id, cognitiveServicesOpenAiUserRoleId)
  properties: {
    principalId: devOpsIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: cognitiveServicesOpenAiUserRole.id
  }
}

resource prodRuntimeOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, prodRuntimeIdentity.id, cognitiveServicesOpenAiUserRoleId)
  properties: {
    principalId: prodRuntimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: cognitiveServicesOpenAiUserRole.id
  }
}

resource prodOpsOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, prodOpsIdentity.id, cognitiveServicesOpenAiUserRoleId)
  properties: {
    principalId: prodOpsIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: cognitiveServicesOpenAiUserRole.id
  }
}

output foundryAccountId string = foundryAccount.id
output foundryResourceGroupName string = resourceGroup().name
output cognitiveServicesOpenAiUserRoleDefinitionId string = cognitiveServicesOpenAiUserRole.id
