// One-time subscription-scoped bootstrap parameters. Provisions the
// dedicated platform, dev, and prod resource groups plus four GitHub OIDC
// identities (development, production-deploy, production-promotion,
// platform) in westus3.
using '../bootstrap.bicep'

param location = 'westus3'
param devResourceGroupName = 'rg-krypto-dev'
param prodResourceGroupName = 'rg-krypto-prod'
param platformResourceGroupName = 'rg-krypto-platform'
param githubOrg = 'VeVarunSharma'
param githubOwnerId = '62218708'
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
