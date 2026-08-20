// Subscription-scoped bootstrap: one-time setup that creates the platform,
// dev, and prod resource groups and four GitHub OIDC-federated user-assigned
// identities, one per approved GitHub Environment, each scoped only to the
// one resource group it is allowed to deploy into:
//
//   - development         -> dev resource group   (environment.bicep,
//                            release.bicep, rollout.bicep for dev)
//   - production-deploy   -> prod resource group  (environment.bicep,
//                            release.bicep for prod — never flips
//                            ROLLOUT_MODE/trigger types)
//   - production-promotion -> prod resource group (rollout.bicep for prod
//                            only — the only identity allowed to run the
//                            template that flips ROLLOUT_MODE/trigger
//                            types; grants no Microsoft.Authorization/
//                            roleAssignments/write since rollout.bicep
//                            never creates a role assignment)
//   - platform            -> platform resource group (platform.bicep and
//                            platform-access/main.bicep only; the one-time account
//                            template includes a delete lock and is deployed
//                            by the bootstrap operator; this identity is never
//                            given any right in the dev or prod resource
//                            groups, and neither the dev nor prod identities
//                            are given any right in the platform resource
//                            group)
//
// Run this once (or whenever environment/repo names change) before
// platform-account.bicep, platform.bicep, platform-access/main.bicep,
// environment.bicep, release.bicep, or rollout.bicep.
//
// NOTE: only the dev/prod-vs-platform resource group scoping above is an
// Azure RBAC-enforced boundary (none of these identities has any Azure
// permission outside its own resource group). "production-deploy never
// runs rollout.bicep" and "production-promotion never runs
// release.bicep" are process/workflow controls, not Azure-enforced action
// restrictions: Contributor (plus, for production-deploy, Role Based
// Access Control Administrator) on the prod resource group can deploy any
// template into it. The actual separation comes from which template each
// GitHub Environment's protected workflow is configured to invoke, and
// from GitHub Environment protection rules (required reviewers, branch
// restrictions) gating who can trigger that workflow — see
// infra/README.md "GitHub Environments and OIDC identities" for the full
// explanation.
//
// Deploy with:
//   az deployment sub create \
//     --location <region> \
//     --template-file infra/bootstrap.bicep \
//     --parameters infra/params/bootstrap.bicepparam
targetScope = 'subscription'

@description('Approved Azure region for all Project Krypto resource groups.')
@allowed([
  'westus3'
])
param location string = 'westus3'

@description('Dev resource group name.')
@allowed([
  'rg-krypto-dev'
])
param devResourceGroupName string = 'rg-krypto-dev'

@description('Prod resource group name.')
@allowed([
  'rg-krypto-prod'
])
param prodResourceGroupName string = 'rg-krypto-prod'

@description('Dedicated resource group for the shared Microsoft Foundry account and its dev/prod model deployments.')
@allowed([
  'rg-krypto-platform'
])
param platformResourceGroupName string = 'rg-krypto-platform'

@description('GitHub repository owner (org or user), e.g. VeVarunSharma.')
param githubOrg string

@description('Immutable GitHub repository owner ID used by the configured OIDC subject format.')
param githubOwnerId string

@description('GitHub repository name, e.g. project-krypto-dog.')
param githubRepo string

@description('Immutable GitHub repository ID used by the configured OIDC subject format.')
param githubRepoId string

@description('GitHub repository Environment name federated to the dev identity. Must match an Environment configured in the repository settings.')
param devGithubEnvironmentName string = 'development'

@description('GitHub repository Environment name federated to the prod deploy identity (runs environment.bicep/release.bicep for prod, never rollout.bicep).')
param prodDeployGithubEnvironmentName string = 'production-deploy'

@description('GitHub repository Environment name federated to the prod promotion identity (runs rollout.bicep for prod only — the one template that flips ROLLOUT_MODE/trigger types).')
param prodPromotionGithubEnvironmentName string = 'production-promotion'

@description('GitHub repository Environment name federated to the platform identity (runs platform.bicep and platform-access/main.bicep only).')
param platformGithubEnvironmentName string = 'platform'

@description('Dev GitHub OIDC identity name.')
param devIdentityName string = 'id-github-oidc-dev'

@description('Prod deploy GitHub OIDC identity name.')
param prodDeployIdentityName string = 'id-github-oidc-prod-deploy'

@description('Prod promotion GitHub OIDC identity name.')
param prodPromotionIdentityName string = 'id-github-oidc-prod-promotion'

@description('Platform GitHub OIDC identity name.')
param platformIdentityName string = 'id-github-oidc-platform'

@description('Tags applied to all three resource groups and their OIDC identities.')
param tags object = {
  project: 'project-krypto'
}

resource devResourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: devResourceGroupName
  location: location
  tags: union(tags, { environment: 'dev' })
}

resource prodResourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: prodResourceGroupName
  location: location
  tags: union(tags, { environment: 'prod' })
}

resource platformResourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: platformResourceGroupName
  location: location
  tags: union(tags, { environment: 'platform' })
}

// Dev: one identity runs environment.bicep, release.bicep, and
// rollout.bicep for dev (dev has no separate deploy/promotion gate), so it
// needs the RBAC-granting role for the first two.
module devOidcIdentity 'modules/oidc-identity.bicep' = {
  name: 'dev-oidc-identity'
  scope: devResourceGroup
  params: {
    identityName: devIdentityName
    location: location
    githubOrg: githubOrg
    githubOwnerId: githubOwnerId
    githubRepo: githubRepo
    githubRepoId: githubRepoId
    githubEnvironmentName: devGithubEnvironmentName
    includeRoleAssignmentAdmin: true
    tags: union(tags, { environment: 'dev' })
  }
}

// Prod deploy: runs environment.bicep and release.bicep for prod, both of
// which create Microsoft.Authorization/roleAssignments (AcrPull, Key Vault
// Secrets User, Storage Blob Data Contributor), so it needs the
// RBAC-granting role. Never runs rollout.bicep.
module prodDeployOidcIdentity 'modules/oidc-identity.bicep' = {
  name: 'prod-deploy-oidc-identity'
  scope: prodResourceGroup
  params: {
    identityName: prodDeployIdentityName
    location: location
    githubOrg: githubOrg
    githubOwnerId: githubOwnerId
    githubRepo: githubRepo
    githubRepoId: githubRepoId
    githubEnvironmentName: prodDeployGithubEnvironmentName
    includeRoleAssignmentAdmin: true
    includeLocksContributor: true
    tags: union(tags, { environment: 'prod' })
  }
}

// Prod promotion: runs ONLY rollout.bicep for prod, which reads existing
// Key Vault secrets and redeploys the web app + scheduler jobs but never
// creates a role assignment, so Contributor alone is sufficient — narrower
// than the deploy identity above.
module prodPromotionOidcIdentity 'modules/oidc-identity.bicep' = {
  name: 'prod-promotion-oidc-identity'
  scope: prodResourceGroup
  params: {
    identityName: prodPromotionIdentityName
    location: location
    githubOrg: githubOrg
    githubOwnerId: githubOwnerId
    githubRepo: githubRepo
    githubRepoId: githubRepoId
    githubEnvironmentName: prodPromotionGithubEnvironmentName
    includeRoleAssignmentAdmin: false
    tags: union(tags, { environment: 'prod' })
  }
}

// Platform: runs ONLY the dedicated platform templates. platform-access/main.bicep
// creates the four reviewed Cognitive Services OpenAI User bindings for the
// dev/prod runtime and ops identities, so this identity needs the current
// RBAC-granting built-in role in addition to Contributor.
//
// SECURITY TRADE-OFF: Role Based Access Control Administrator is scoped to
// rg-krypto-platform only, never the subscription or the dev/prod resource
// groups. That scope is narrow, but the built-in role is NOT constrained to
// assigning only Cognitive Services OpenAI User. A compromised or
// over-broadly-approved platform workflow could assign Owner (or another
// privileged role) inside rg-krypto-platform. This remains a protected
// GitHub Environment/process control, not an Azure-enforced restriction on
// which role may be assigned. Keep platform workflow/template review and
// environment protection rules as mandatory controls.
module platformOidcIdentity 'modules/oidc-identity.bicep' = {
  name: 'platform-oidc-identity'
  scope: platformResourceGroup
  params: {
    identityName: platformIdentityName
    location: location
    githubOrg: githubOrg
    githubOwnerId: githubOwnerId
    githubRepo: githubRepo
    githubRepoId: githubRepoId
    githubEnvironmentName: platformGithubEnvironmentName
    includeRoleAssignmentAdmin: true
    includeLocksContributor: true
    tags: union(tags, { environment: 'platform' })
  }
}

// The platform workflow validates live model quota before deployment. That
// usage endpoint is subscription-scoped, so the otherwise platform-RG-scoped
// identity receives this one read-only subscription role and no subscription
// mutation permission.
var cognitiveServicesUsagesReaderRoleId = 'bba48692-92b0-4667-a9ad-c31c7b334ac2'
resource platformQuotaReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(
    subscription().id,
    platformIdentityName,
    cognitiveServicesUsagesReaderRoleId
  )
  properties: {
    principalId: platformOidcIdentity.outputs.identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      cognitiveServicesUsagesReaderRoleId
    )
  }
}

// RG-scoped deployment identities cannot read subscription provider
// registration state. Define one minimal read-only custom role rather than
// granting broad subscription Reader.
var providerRegistrationReaderRoleId = guid(
  subscription().id,
  'project-krypto-provider-registration-reader'
)
resource providerRegistrationReaderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: providerRegistrationReaderRoleId
  properties: {
    roleName: 'Project Krypto Provider Registration Reader'
    description: 'Reads Azure resource-provider registration state for fail-closed deployment preflight.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Resources/subscriptions/providers/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      subscription().id
    ]
  }
}

resource devProviderRegistrationReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, devIdentityName, providerRegistrationReaderRoleId)
  properties: {
    principalId: devOidcIdentity.outputs.identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: providerRegistrationReaderRole.id
  }
}

resource prodDeployProviderRegistrationReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(
    subscription().id,
    prodDeployIdentityName,
    providerRegistrationReaderRoleId
  )
  properties: {
    principalId: prodDeployOidcIdentity.outputs.identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: providerRegistrationReaderRole.id
  }
}

resource platformProviderRegistrationReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(
    subscription().id,
    platformIdentityName,
    providerRegistrationReaderRoleId
  )
  properties: {
    principalId: platformOidcIdentity.outputs.identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: providerRegistrationReaderRole.id
  }
}

output devResourceGroupName string = devResourceGroup.name
output prodResourceGroupName string = prodResourceGroup.name
output platformResourceGroupName string = platformResourceGroup.name

output devIdentityClientId string = devOidcIdentity.outputs.identityClientId
output devIdentityPrincipalId string = devOidcIdentity.outputs.identityPrincipalId
output devIdentityResourceId string = devOidcIdentity.outputs.identityId

output prodDeployIdentityClientId string = prodDeployOidcIdentity.outputs.identityClientId
output prodDeployIdentityPrincipalId string = prodDeployOidcIdentity.outputs.identityPrincipalId
output prodDeployIdentityResourceId string = prodDeployOidcIdentity.outputs.identityId

output prodPromotionIdentityClientId string = prodPromotionOidcIdentity.outputs.identityClientId
output prodPromotionIdentityPrincipalId string = prodPromotionOidcIdentity.outputs.identityPrincipalId
output prodPromotionIdentityResourceId string = prodPromotionOidcIdentity.outputs.identityId

output platformIdentityClientId string = platformOidcIdentity.outputs.identityClientId
output platformIdentityPrincipalId string = platformOidcIdentity.outputs.identityPrincipalId
output platformIdentityResourceId string = platformOidcIdentity.outputs.identityId
