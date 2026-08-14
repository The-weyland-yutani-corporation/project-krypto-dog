// A single GitHub OIDC-federated user-assigned identity, scoped to one
// GitHub repository Environment, with narrowly scoped roles limited to the
// one resource group it is allowed to deploy into. Used by bootstrap.bicep
// once per identity: development, production-deploy, production-promotion,
// and platform.
targetScope = 'resourceGroup'

@description('Identity name, e.g. id-github-oidc-dev.')
param identityName string

@description('Azure region.')
param location string

@description('GitHub repository owner (org or user), e.g. VeVarunSharma.')
param githubOrg string

@description('GitHub repository name, e.g. project-krypto-dog.')
param githubRepo string

@description('GitHub repository Environment name this identity is federated to, e.g. development, production-deploy, production-promotion, or platform.')
param githubEnvironmentName string

@description('Whether to also grant Role Based Access Control Administrator (needed to create Microsoft.Authorization/roleAssignments, e.g. for environment/release workload bindings or platform Foundry inference bindings). Leave false for identities that deploy no role assignments, such as prod promotion.')
param includeRoleAssignmentAdmin bool = true

@description('Whether to grant Locks Contributor in this resource group. Used only by the protected platform identity so platform-account.bicep can create and maintain its CanNotDelete lock.')
param includeLocksContributor bool = false

@description('Tags applied to the identity.')
param tags object = {}

// Contributor: deploy/manage resources within this resource group only.
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
// Role Based Access Control Administrator: assign roles to workload
// identities (AcrPull, Key Vault Secrets User, Storage Blob Data
// Contributor) within this resource group only. NOTE: live role
// definition inspection (`az role definition list --name "Role Based
// Access Control Administrator"`) shows this built-in role grants
// Microsoft.Authorization/roleAssignments/write AND /delete with no
// `condition` and no `notActions` restricting which roles it may assign —
// it does NOT inherently block assigning Owner, User Access
// Administrator, or itself, and is therefore not a privilege-escalation
// guard by itself. It is preferred here over the older User Access
// Administrator purely because it is the current, non-deprecated
// equivalent built-in role for this purpose; the actual limiting factor
// is that this identity is scoped to a single resource group (never
// subscription-wide) and that only this bootstrap's own reviewed Bicep
// modules are ever deployed with it — i.e. the restriction is a
// resource-group scope + process/workflow-approval control (what
// templates a given GitHub Environment's protection rules allow to run),
// not an Azure-enforced role-assignment restriction. Combined with
// Contributor this is scoped no wider than the one resource group, but an
// operator or compromised workflow run with this identity's credentials
// could still assign Owner (or any other role) within that resource
// group if not otherwise prevented by branch/environment protection.
var rbacAdministratorRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
// Locks Contributor: manage resource locks without broader resource access.
var locksContributorRoleId = '28bf596f-4eb7-45ce-b5bc-6cf482fec137'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
  tags: tags
}

resource federatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = {
  parent: identity
  name: 'github-environment-${githubEnvironmentName}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    audiences: [
      'api://AzureADTokenExchange'
    ]
    subject: 'repo:${githubOrg}/${githubRepo}:environment:${githubEnvironmentName}'
  }
}

resource contributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identity.id, contributorRoleId)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
  }
}

resource userAccessAdministratorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (includeRoleAssignmentAdmin) {
  name: guid(resourceGroup().id, identity.id, rbacAdministratorRoleId)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdministratorRoleId)
  }
}

resource locksContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (includeLocksContributor) {
  name: guid(resourceGroup().id, identity.id, locksContributorRoleId)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', locksContributorRoleId)
  }
}

output identityId string = identity.id
output identityPrincipalId string = identity.properties.principalId
output identityClientId string = identity.properties.clientId
