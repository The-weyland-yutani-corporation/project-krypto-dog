// The template resolves the four fixed runtime/ops UAMIs by their reviewed
// resource-group/name pairs. The protected workflow independently verifies the
// two schedulers have zero Foundry access. No caller-supplied principal ID is an
// authorization input.
//
// The only other approved pair is the dedicated future target:
//   ai-krypto-westus3 in rg-krypto-platform
using '../platform-access/main.bicep'

param foundryAccountName = 'ghcp-foundry-eastus2'
