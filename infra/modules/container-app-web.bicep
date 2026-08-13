// Reusable module for the external Next.js web Container App. Used by
// release.bicep (initial/redeploy, always lands with rolloutMode
// 'disabled') and by rollout.bicep (the only template allowed to pass a
// different rolloutMode). Takes a digest-pinned image reference only —
// never a mutable tag.
targetScope = 'resourceGroup'

@description('Container App name.')
param appName string

@description('Azure region.')
param location string

@description('Container Apps managed environment resource ID.')
param managedEnvironmentId string

@description('Workload profile name to run on (must exist on the managed environment).')
param workloadProfileName string = 'Consumption'

@description('ACR login server, e.g. myregistry.azurecr.io.')
param registryLoginServer string

@description('Digest-pinned image reference, e.g. myregistry.azurecr.io/krypto-web@sha256:<digest>. Must not be a mutable tag such as :latest.')
@minLength(1)
param imageDigestRef string

@description('Resource ID of the user-assigned runtime identity. Used both for ACR pull and Key Vault secret references.')
param runtimeIdentityId string

@description('Rollout mode value for this deployment. release.bicep must always pass "disabled"; only rollout.bicep may pass a different value.')
@allowed([
  'disabled'
  'shadow'
  'paper'
])
param rolloutMode string

@description('Non-secret environment variables as {name, value} objects.')
param nonSecretEnv array = []

@description('Key Vault-backed secret environment variables as {name, keyVaultUrl} objects. keyVaultUrl must be a versionless secret URI (e.g. the Key Vault secret resource\'s .properties.secretUri, not .properties.secretUriWithVersion) so Container Apps resolves the latest secret version on rotation without requiring a redeploy of this template.')
param keyVaultSecretEnv array = []

@description('Target container port the app listens on.')
param targetPort int = 3000

@description('Minimum replica count.')
param minReplicas int = 1

@description('Maximum replica count.')
param maxReplicas int = 3

@description('Tags applied to the Container App.')
param tags object = {}

var secrets = [
  for entry in keyVaultSecretEnv: {
    name: toLower(replace(entry.name, '_', '-'))
    keyVaultUrl: entry.keyVaultUrl
    identity: runtimeIdentityId
  }
]

var secretEnvVars = [
  for entry in keyVaultSecretEnv: {
    name: entry.name
    secretRef: toLower(replace(entry.name, '_', '-'))
  }
]

var rolloutModeEnv = [
  {
    name: 'ROLLOUT_MODE'
    value: rolloutMode
  }
]

resource webApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    workloadProfileName: workloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registryLoginServer
          identity: runtimeIdentityId
        }
      ]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: appName
          image: imageDigestRef
          env: concat(nonSecretEnv, rolloutModeEnv, secretEnvVars)
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health/live'
                port: targetPort
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health/ready'
                port: targetPort
              }
              initialDelaySeconds: 5
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output appId string = webApp.id
output appName string = webApp.name
output fqdn string = webApp.properties.configuration.ingress.fqdn
