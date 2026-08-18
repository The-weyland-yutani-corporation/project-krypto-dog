// Deploys isolated dev/prod Foundry projects and the least-privilege RBAC
// required to create and consume Project Krypto's read-only prompt agents.
// The parent account and its pinned model deployments must already exist.
// This template does not create models, change account networking/auth, or
// grant any trading/application permission to an agent.
// The operational account is shared, so its remaining legacy local-auth
// setting is documented as a production-promotion blocker rather than mutated
// by this project-scoped deployment.
targetScope = 'resourceGroup'

@description('Existing Microsoft Foundry account in this resource group.')
param foundryAccountName string

@description('Azure region of the existing Foundry account.')
param location string

@description('Development Foundry project name.')
param devProjectName string = 'krypto-dev-agents'

@description('Production Foundry project name.')
param prodProjectName string = 'krypto-prod-agents'

@description('Principal allowed to create immutable prompt-agent versions.')
param agentDeployerPrincipalId string

@description('Principal type for agentDeployerPrincipalId.')
@allowed([
  'User'
  'ServicePrincipal'
])
param agentDeployerPrincipalType string

@description('Development runtime managed identity principal ID.')
param devRuntimePrincipalId string

@description('Development ops managed identity principal ID.')
param devOpsPrincipalId string

@description('Production runtime managed identity principal ID.')
param prodRuntimePrincipalId string

@description('Production ops managed identity principal ID.')
param prodOpsPrincipalId string

@description('Tags applied to Foundry projects.')
param tags object = {
  project: 'project-krypto'
  component: 'decision-agent'
  managedBy: 'bicep'
}

var foundryUserRoleId = '53ca6127-db72-4b80-b1b0-d745d6d5456d'
var foundryAgentInvokerRoleId = '44dfdabf-22ec-45f5-923b-b42e44bdad76'

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}

resource devProject 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundryAccount
  name: devProjectName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  tags: union(tags, { environment: 'dev' })
  properties: {
    displayName: 'Project Krypto development agents'
    description: 'Development-only read-only decision agents.'
  }
}

resource prodProject 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundryAccount
  name: prodProjectName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  tags: union(tags, { environment: 'prod' })
  properties: {
    displayName: 'Project Krypto production agents'
    description: 'Production-safe read-only decision agents; trading remains disabled/manual.'
  }
}

resource devDeployerFoundryUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: devProject
  name: guid(devProject.id, agentDeployerPrincipalId, foundryUserRoleId)
  properties: {
    principalId: agentDeployerPrincipalId
    principalType: agentDeployerPrincipalType
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryUserRoleId)
  }
}

resource prodDeployerFoundryUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: prodProject
  name: guid(prodProject.id, agentDeployerPrincipalId, foundryUserRoleId)
  properties: {
    principalId: agentDeployerPrincipalId
    principalType: agentDeployerPrincipalType
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryUserRoleId)
  }
}

resource devProjectIdentityFoundryUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: devProject
  name: guid(devProject.id, devProject.id, foundryUserRoleId)
  properties: {
    principalId: devProject.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryUserRoleId)
  }
}

resource prodProjectIdentityFoundryUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: prodProject
  name: guid(prodProject.id, prodProject.id, foundryUserRoleId)
  properties: {
    principalId: prodProject.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryUserRoleId)
  }
}

resource devRuntimeAgentInvoker 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: devProject
  name: guid(devProject.id, devRuntimePrincipalId, foundryAgentInvokerRoleId)
  properties: {
    principalId: devRuntimePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryAgentInvokerRoleId)
  }
}

resource devOpsAgentInvoker 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: devProject
  name: guid(devProject.id, devOpsPrincipalId, foundryAgentInvokerRoleId)
  properties: {
    principalId: devOpsPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryAgentInvokerRoleId)
  }
}

resource prodRuntimeAgentInvoker 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: prodProject
  name: guid(prodProject.id, prodRuntimePrincipalId, foundryAgentInvokerRoleId)
  properties: {
    principalId: prodRuntimePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryAgentInvokerRoleId)
  }
}

resource prodOpsAgentInvoker 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: prodProject
  name: guid(prodProject.id, prodOpsPrincipalId, foundryAgentInvokerRoleId)
  properties: {
    principalId: prodOpsPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryAgentInvokerRoleId)
  }
}

output devProjectName string = devProject.name
output devProjectEndpoint string = 'https://${foundryAccountName}.services.ai.azure.com/api/projects/${devProject.name}'
output prodProjectName string = prodProject.name
output prodProjectEndpoint string = 'https://${foundryAccountName}.services.ai.azure.com/api/projects/${prodProject.name}'
