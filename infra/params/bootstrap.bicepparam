// One-time subscription-scoped bootstrap parameters. Provisions the dev
// and prod resource groups plus four GitHub OIDC identities (development,
// production-deploy, production-promotion, platform) in a single
// deployment. Replace the placeholder values below (githubOrg, githubRepo,
// location, platformResourceGroupName) with the real repository/region/
// existing-Foundry-resource-group before deploying — none of these are
// secrets, but platformResourceGroupName MUST point at a resource group
// that already exists (this template does not create it). See
// infra/README.md for the full bootstrap procedure and the GitHub
// Environment names these identities must be federated to.
using '../bootstrap.bicep'

param location = 'eastus2'
param devResourceGroupName = 'rg-krypto-dev'
param prodResourceGroupName = 'rg-krypto-prod'
// REPLACE with the resource group name that already holds the existing
// Microsoft Foundry account. Not invented/guessed — must be supplied by
// the operator who owns that platform resource group.
param platformResourceGroupName = 'REPLACE_WITH_EXISTING_PLATFORM_RESOURCE_GROUP_NAME'
param githubOrg = 'VeVarunSharma'
param githubRepo = 'project-krypto-dog'
param devGithubEnvironmentName = 'development'
param prodDeployGithubEnvironmentName = 'production-deploy'
param prodPromotionGithubEnvironmentName = 'production-promotion'
param platformGithubEnvironmentName = 'platform'
param devIdentityName = 'id-github-oidc-dev'
param prodDeployIdentityName = 'id-github-oidc-prod-deploy'
param prodPromotionIdentityName = 'id-github-oidc-prod-promotion'
param platformIdentityName = 'id-github-oidc-platform'
param tags = {
  project: 'project-krypto'
}
