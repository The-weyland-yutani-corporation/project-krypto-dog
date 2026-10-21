// Dedicated Project Krypto Microsoft Foundry account. This account is shared
// by the separately named dev/prod model deployments but isolated from both
// application resource groups.
using '../platform-account.bicep'

param location = 'westus3'
param foundryAccountName = 'ai-krypto-westus3-02'
param tags = {
  project: 'project-krypto'
  component: 'foundry-platform'
  environment: 'shared'
  managedBy: 'bicep'
}
