// Copy the four principal-ID outputs from the dev/prod environment.bicep
// deployments before applying this account-scoped access template.
using '../platform-access.bicep'

param foundryAccountName = 'ai-krypto-westus3'
param devRuntimePrincipalId = 'REPLACE_WITH_DEV_RUNTIME_PRINCIPAL_ID'
param devOpsPrincipalId = 'REPLACE_WITH_DEV_OPS_PRINCIPAL_ID'
param prodRuntimePrincipalId = 'REPLACE_WITH_PROD_RUNTIME_PRINCIPAL_ID'
param prodOpsPrincipalId = 'REPLACE_WITH_PROD_OPS_PRINCIPAL_ID'
