// One-time subscription-scoped bootstrap parameters. Provisions the
// dedicated platform, dev, and prod resource groups; four GitHub OIDC
// identities (development, production-deploy, production-promotion,
// platform); and the reviewed subscription custom-role definitions.
using '../bootstrap.bicep'

param location = 'westus3'
param devResourceGroupName = 'rg-krypto-dev'
param prodResourceGroupName = 'rg-krypto-prod'
param platformResourceGroupName = 'rg-krypto-platform'
param githubOrg = 'The-weyland-yutani-corporation'
param githubOwnerId = '264313301'
param githubRepo = 'project-krypto-dog'
param githubRepoId = '1189023287'
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
