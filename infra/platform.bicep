// Resource-group-scoped template deployed into the resource group that
// already holds the existing Microsoft Foundry (Azure AI Foundry /
// Cognitive Services) account. References that account as an existing
// resource — it is never created or modified by this repo — and declares
// separate, independently parameterized dev and prod model deployments
// under it, per ADR 0008 item 7 (shared account/quota/key boundary,
// separate deployments per environment).
//
// Model name/version/SKU/capacity are required parameters with no
// defaults: this template does not assert or invent any claim about
// what model, quota, or capacity is actually approved. Supply the
// reviewed values via the .bicepparam files (after replacing the
// placeholders) or via --parameters at deploy time.
//
// Deploy with:
//   az deployment group create \
//     --resource-group <existing-foundry-account-resource-group> \
//     --template-file infra/platform.bicep \
//     --parameters infra/params/platform.bicepparam
targetScope = 'resourceGroup'

@description('Name of the existing Microsoft Foundry / Cognitive Services account. Not created or modified by this template.')
param foundryAccountName string

@description('Dev model deployment name.')
param devDeploymentName string

@description('Dev model publisher format, e.g. OpenAI or Anthropic.')
param devModelFormat string

@description('Dev model name, e.g. claude-3-5-sonnet-20241022.')
param devModelName string

@description('Dev model version, exactly as published by the provider.')
param devModelVersion string

@description('Dev deployment SKU name, e.g. GlobalStandard or Standard.')
param devSkuName string

@description('Dev deployment capacity (provider-defined throughput units). Must reflect an actually approved/reviewed quota allocation, not an assumed value.')
@minValue(1)
param devSkuCapacity int

@description('Prod model deployment name.')
param prodDeploymentName string

@description('Prod model publisher format, e.g. OpenAI or Anthropic.')
param prodModelFormat string

@description('Prod model name, exactly as published by the provider.')
param prodModelName string

@description('Prod model version, exactly as published by the provider.')
param prodModelVersion string

@description('Prod deployment SKU name, e.g. GlobalStandard or Standard.')
param prodSkuName string

@description('Prod deployment capacity (provider-defined throughput units). Must reflect an actually approved/reviewed quota allocation, not an assumed value.')
@minValue(1)
param prodSkuCapacity int

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}

resource devDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundryAccount
  name: devDeploymentName
  sku: {
    name: devSkuName
    capacity: devSkuCapacity
  }
  properties: {
    model: {
      format: devModelFormat
      name: devModelName
      version: devModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource prodDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundryAccount
  name: prodDeploymentName
  sku: {
    name: prodSkuName
    capacity: prodSkuCapacity
  }
  properties: {
    model: {
      format: prodModelFormat
      name: prodModelName
      version: prodModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

output foundryAccountEndpoint string = foundryAccount.properties.endpoint
output devDeploymentName string = devDeployment.name
output prodDeploymentName string = prodDeployment.name
