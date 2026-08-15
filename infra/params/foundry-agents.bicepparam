// Replace principal IDs at deployment time. Never commit live identity IDs.
using '../foundry-agents.bicep'

param foundryAccountName = 'REPLACE_WITH_FOUNDRY_ACCOUNT_NAME'
param location = 'eastus2'
param devProjectName = 'krypto-dev-agents'
param prodProjectName = 'krypto-prod-agents'
param agentDeployerPrincipalId = 'REPLACE_WITH_AGENT_DEPLOYER_PRINCIPAL_ID'
param agentDeployerPrincipalType = 'User'
param devRuntimePrincipalId = 'REPLACE_WITH_DEV_RUNTIME_PRINCIPAL_ID'
param devOpsPrincipalId = 'REPLACE_WITH_DEV_OPS_PRINCIPAL_ID'
param prodRuntimePrincipalId = 'REPLACE_WITH_PROD_RUNTIME_PRINCIPAL_ID'
param prodOpsPrincipalId = 'REPLACE_WITH_PROD_OPS_PRINCIPAL_ID'

param tags = {
  project: 'project-krypto'
  component: 'decision-agent'
  managedBy: 'bicep'
}
