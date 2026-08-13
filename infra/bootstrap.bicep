// Subscription-scoped bootstrap: one-time setup that creates the dev and
// prod resource groups and four GitHub OIDC-federated user-assigned
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
//   - platform            -> the EXISTING resource group that already
//                            holds the Microsoft Foundry account
//                            (platform.bicep only; never given any right
//                            in the dev or prod resource groups, and
//                            neither the dev nor prod identities are given
//                            any right in the platform resource group)
//
// Run this once (or whenever environment/repo names change) before
// platform.bicep, environment.bicep, release.bicep, or rollout.bicep.
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

@description('Azure region for the resource groups (resource group location only; individual resources choose their own region params later).')
param location string

@description('Dev resource group name.')
param devResourceGroupName string = 'rg-krypto-dev'

@description('Prod resource group name.')
param prodResourceGroupName string = 'rg-krypto-prod'

@description('Resource group name that already holds the existing Microsoft Foundry account platform.bicep deploys into. This template does not create it — it must already exist — so the platform GitHub OIDC identity can be scoped to exactly this one resource group and nothing else, never to the dev or prod resource groups.')
param platformResourceGroupName string

@description('GitHub repository owner (org or user), e.g. VeVarunSharma.')
param githubOrg string

@description('GitHub repository name, e.g. project-krypto-dog.')
param githubRepo string

@description('GitHub repository Environment name federated to the dev identity. Must match an Environment configured in the repository settings.')
param devGithubEnvironmentName string = 'development'

@description('GitHub repository Environment name federated to the prod deploy identity (runs environment.bicep/release.bicep for prod, never rollout.bicep).')
param prodDeployGithubEnvironmentName string = 'production-deploy'

@description('GitHub repository Environment name federated to the prod promotion identity (runs rollout.bicep for prod only — the one template that flips ROLLOUT_MODE/trigger types).')
param prodPromotionGithubEnvironmentName string = 'production-promotion'

@description('GitHub repository Environment name federated to the platform identity (runs platform.bicep only).')
param platformGithubEnvironmentName string = 'platform'

@description('Dev GitHub OIDC identity name.')
param devIdentityName string = 'id-github-oidc-dev'

@description('Prod deploy GitHub OIDC identity name.')
param prodDeployIdentityName string = 'id-github-oidc-prod-deploy'

@description('Prod promotion GitHub OIDC identity name.')
param prodPromotionIdentityName string = 'id-github-oidc-prod-promotion'

@description('Platform GitHub OIDC identity name.')
param platformIdentityName string = 'id-github-oidc-platform'

@description('Tags applied to both resource groups.')
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
    githubRepo: githubRepo
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
    githubRepo: githubRepo
    githubEnvironmentName: prodDeployGithubEnvironmentName
    includeRoleAssignmentAdmin: true
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
    githubRepo: githubRepo
    githubEnvironmentName: prodPromotionGithubEnvironmentName
    includeRoleAssignmentAdmin: false
    tags: union(tags, { environment: 'prod' })
  }
}

// Platform: runs ONLY platform.bicep, which declares Cognitive Services
// model deployments under the existing Foundry account and creates no
// role assignment, so Contributor alone is sufficient. Scoped to the
// existing platform resource group only — resourceGroup(name) targets it
// without this template creating or otherwise managing it, so this
// identity is never given any right in the dev or prod resource groups
// and the dev/prod identities are never given any right here.
module platformOidcIdentity 'modules/oidc-identity.bicep' = {
  name: 'platform-oidc-identity'
  scope: resourceGroup(platformResourceGroupName)
  params: {
    identityName: platformIdentityName
    location: location
    githubOrg: githubOrg
    githubRepo: githubRepo
    githubEnvironmentName: platformGithubEnvironmentName
    includeRoleAssignmentAdmin: false
    tags: union(tags, { environment: 'platform' })
  }
}

output devResourceGroupName string = devResourceGroup.name
output prodResourceGroupName string = prodResourceGroup.name

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
