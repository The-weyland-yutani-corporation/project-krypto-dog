// platform.bicep is deployed once (not per dev/prod resource group) into
// the resource group that already holds the existing Microsoft Foundry
// account, because dev and prod share that one account's quota/key
// boundary (ADR 0008 item 7) — only the model *deployments* differ.
//
// Every value below is a placeholder. Replace foundryAccountName with the
// real existing account name, and replace every model/version/SKU/capacity
// value with the actual reviewed and quota-approved configuration before
// deploying. This template intentionally has no defaults for those
// values so a placeholder cannot be deployed by accident without editing
// this file first.
using '../platform.bicep'

param foundryAccountName = 'REPLACE_WITH_EXISTING_FOUNDRY_ACCOUNT_NAME'

param devDeploymentName = 'krypto-dev-claude'
param devModelFormat = 'Anthropic'
param devModelName = 'REPLACE_WITH_REVIEWED_MODEL_NAME'
param devModelVersion = 'REPLACE_WITH_REVIEWED_MODEL_VERSION'
param devSkuName = 'GlobalStandard'
param devSkuCapacity = 1

param prodDeploymentName = 'krypto-prod-claude'
param prodModelFormat = 'Anthropic'
param prodModelName = 'REPLACE_WITH_REVIEWED_MODEL_NAME'
param prodModelVersion = 'REPLACE_WITH_REVIEWED_MODEL_VERSION'
param prodSkuName = 'GlobalStandard'
param prodSkuCapacity = 1
