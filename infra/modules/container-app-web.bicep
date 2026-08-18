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

@description('Versionless Key Vault URI for the Entra web app client secret used only by Container Apps authentication. It is registered as a Container App secret but is not exposed to the application container environment.')
@secure()
param adminEntraClientSecretKeyVaultUrl string

@description('Microsoft Entra application client ID for this exact Container App origin.')
@minLength(36)
@maxLength(36)
param adminEntraClientId string

@description('Exact token audience accepted by both Container Apps authentication and application authorization.')
@minLength(1)
param adminEntraAudience string

@description('Exact Entra v2 OpenID issuer for the configured tenant and Azure cloud.')
@minLength(1)
param adminEntraIssuer string

@description('Immutable allowlisted Microsoft Entra operator object IDs. Names and roles are enforced again by application authorization.')
@minLength(1)
param adminEntraAllowedPrincipalIds array

@description('Conditional Access authentication context required for routine MFA-backed administration.')
@minLength(1)
param adminEntraMfaAuthContext string

@description('Distinct Conditional Access authentication context required for recent sensitive-operation step-up.')
@minLength(1)
param adminEntraStepUpAuthContext string

@description('Target container port the app listens on.')
param targetPort int = 3000

@description('Minimum replica count.')
param minReplicas int = 1

@description('Maximum replica count.')
param maxReplicas int = 3

@description('Tags applied to the Container App.')
param tags object = {}

var environmentSecrets = [
  for entry in keyVaultSecretEnv: {
    name: toLower(replace(entry.name, '_', '-'))
    keyVaultUrl: entry.keyVaultUrl
    identity: runtimeIdentityId
  }
]

var adminEntraClientSecretName = 'admin-entra-client-secret'
var validatedAdminEntraStepUpAuthContext = adminEntraStepUpAuthContext == adminEntraMfaAuthContext
  ? fail('Admin routine MFA and sensitive step-up authentication contexts must be distinct.')
  : adminEntraStepUpAuthContext
var secrets = concat(environmentSecrets, [
  {
    name: adminEntraClientSecretName
    keyVaultUrl: adminEntraClientSecretKeyVaultUrl
    identity: runtimeIdentityId
  }
])

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
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health/ready'
                port: targetPort
              }
              initialDelaySeconds: 5
              periodSeconds: 15
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'bounded-http-admission'
            http: {
              metadata: {
                concurrentRequests: '1'
              }
            }
          }
        ]
      }
    }
  }
}

resource adminAuth 'Microsoft.App/containerApps/authConfigs@2025-01-01' = {
  parent: webApp
  name: 'current'
  properties: {
    globalValidation: {
      unauthenticatedClientAction: 'AllowAnonymous'
      redirectToProvider: 'azureactivedirectory'
    }
    httpSettings: {
      requireHttps: true
      routes: {
        apiPrefix: '/.auth'
      }
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        login: {
          disableWWWAuthenticate: false
          loginParameters: [
            'max_age=300'
            'prompt=login'
            'claims={"id_token":{"acrs":{"essential":true,"value":"${validatedAdminEntraStepUpAuthContext}"}}}'
          ]
        }
        registration: {
          clientId: adminEntraClientId
          clientSecretSettingName: adminEntraClientSecretName
          openIdIssuer: adminEntraIssuer
        }
        validation: {
          allowedAudiences: [
            adminEntraAudience
          ]
          defaultAuthorizationPolicy: {
            allowedPrincipals: {
              identities: adminEntraAllowedPrincipalIds
            }
          }
        }
      }
    }
    login: {
      allowedExternalRedirectUrls: []
      cookieExpiration: {
        convention: 'FixedTime'
        timeToExpiration: '08:00:00'
      }
      nonce: {
        nonceExpirationInterval: '00:05:00'
        validateNonce: true
      }
      preserveUrlFragmentsForLogins: false
      tokenStore: {
        enabled: true
        tokenRefreshExtensionHours: 8
      }
    }
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }
  }
}

output appId string = webApp.id
output appName string = webApp.name
output fqdn string = webApp.properties.configuration.ingress.fqdn
