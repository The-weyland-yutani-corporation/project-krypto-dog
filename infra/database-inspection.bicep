// Temporary read-only configuration of the existing migrate-init slot.
// This template creates no secret, role assignment, database or application.
targetScope = 'resourceGroup'

param location string
param containerAppsEnvironmentId string
param registryLoginServer string
param imageRepository string
param opsImageDigest string
param opsIdentityId string
param opsIdentityClientId string
param keyVaultName string
param evidenceContainerUrl string
param releaseSha string
param databaseHost string
param databaseName string = 'postgres'
param runtimeLoginRole string = 'krypto_app'
param owner string

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource directUrlSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: 'direct-url'
}

module inspection 'modules/container-app-job.bicep' = {
  name: 'database-inspection-job'
  params: {
    jobName: 'caj-prod-migrate-init'
    location: location
    managedEnvironmentId: containerAppsEnvironmentId
    registryLoginServer: registryLoginServer
    imageDigestRef: '${registryLoginServer}/${imageRepository}@${opsImageDigest}'
    jobIdentityId: opsIdentityId
    triggerType: 'Manual'
    replicaRetryLimit: 0
    replicaTimeoutSeconds: 120
    command: [
      'npm'
    ]
    args: [
      'run'
      'azure:ops-job'
    ]
    nonSecretEnv: [
      { name: 'ENVIRONMENT_NAME', value: 'prod' }
      { name: 'RELEASE_SHA', value: releaseSha }
      { name: 'OPERATION', value: 'database-inspection' }
      { name: 'OPS_IMAGE_DIGEST', value: opsImageDigest }
      { name: 'EVIDENCE_CONTAINER_URL', value: evidenceContainerUrl }
      { name: 'AZCOPY_MSI_CLIENT_ID', value: opsIdentityClientId }
      { name: 'AZURE_CLIENT_ID', value: opsIdentityClientId }
      { name: 'DATABASE_INSPECTION_HOST', value: databaseHost }
      { name: 'DATABASE_INSPECTION_NAME', value: databaseName }
      { name: 'AZURE_RUNTIME_LOGIN_ROLE', value: runtimeLoginRole }
    ]
    keyVaultSecretEnv: [
      { name: 'DIRECT_URL', keyVaultUrl: directUrlSecret.properties.secretUri }
    ]
    tags: {
      project: 'project-krypto'
      environment: 'prod'
      'krypto-bootstrap-owner': owner
    }
  }
}

output jobId string = inspection.outputs.jobId
