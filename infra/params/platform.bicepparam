// Reviewed model deployment configuration for the dedicated shared Foundry
// account in rg-krypto-platform. Account creation remains separate in
// platform-account.bicep.
using '../platform.bicep'

param foundryAccountName = 'ai-krypto-westus3-02'
param platformSmokePrincipalId = 'REPLACE_WITH_PLATFORM_SMOKE_PRINCIPAL_ID'

param devDeploymentName = 'krypto-dev-luna'
param devModelFormat = 'OpenAI'
param devModelName = 'gpt-5.6-luna'
param devModelVersion = '2026-07-09'
param devSkuName = 'GlobalStandard'
param devSkuCapacity = 10

param prodDeploymentName = 'krypto-prod-luna'
param prodModelFormat = 'OpenAI'
param prodModelName = 'gpt-5.6-luna'
param prodModelVersion = '2026-07-09'
param prodSkuName = 'GlobalStandard'
param prodSkuCapacity = 10
