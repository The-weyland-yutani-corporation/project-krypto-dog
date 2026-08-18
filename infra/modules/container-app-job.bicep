// Reusable module for a Container Apps Job (scheduler jobs and the
// manual ops job). Used by release.bicep (initial/redeploy; scheduler
// jobs always land as triggerType 'Manual') and by rollout.bicep (the
// only template allowed to switch a scheduler job's triggerType to
// 'Schedule'). Takes a digest-pinned image reference only.
targetScope = 'resourceGroup'

@description('Container Apps Job name.')
param jobName string

@description('Azure region.')
param location string

@description('Container Apps managed environment resource ID.')
param managedEnvironmentId string

@description('Workload profile name to run on (must exist on the managed environment).')
param workloadProfileName string = 'Consumption'

@description('ACR login server, e.g. myregistry.azurecr.io.')
param registryLoginServer string

@description('Digest-pinned image reference. Must not be a mutable tag such as :latest.')
@minLength(1)
param imageDigestRef string

@description('Resource ID of the user-assigned identity this job runs as. Must be scoped to only the secrets/roles this job needs.')
param jobIdentityId string

@description('Trigger type. "Manual" for operator-invoked jobs and the pre-promotion default for scheduler jobs; "Schedule" only after rollout.bicep promotes a scheduler job.')
@allowed([
  'Manual'
  'Schedule'
])
param triggerType string = 'Manual'

@description('CRON expression, UTC. Required (and only used) when triggerType is Schedule.')
param cronExpression string = ''

@description('Number of failed retries allowed before the job execution is marked Failed.')
@minValue(0)
@maxValue(10)
param replicaRetryLimit int = 0

@description('Per-execution timeout in seconds.')
param replicaTimeoutSeconds int = 600

@description('Container command override. Empty array uses the image default entrypoint.')
param command array = []

@description('Container args override.')
param args array = []

@description('Non-secret environment variables as {name, value} objects.')
param nonSecretEnv array = []

@description('Key Vault-backed secret environment variables as {name, keyVaultUrl} objects. keyVaultUrl must be a versionless secret URI (e.g. the Key Vault secret resource\'s .properties.secretUri, not .properties.secretUriWithVersion) so Container Apps resolves the latest secret version on rotation without requiring a redeploy of this template.')
param keyVaultSecretEnv array = []

@description('Tags applied to the job.')
param tags object = {}

var secrets = [
  for entry in keyVaultSecretEnv: {
    name: toLower(replace(entry.name, '_', '-'))
    keyVaultUrl: entry.keyVaultUrl
    identity: jobIdentityId
  }
]

var secretEnvVars = [
  for entry in keyVaultSecretEnv: {
    name: entry.name
    secretRef: toLower(replace(entry.name, '_', '-'))
  }
]

var manualTriggerConfig = {
  parallelism: 1
  replicaCompletionCount: 1
}

var scheduleTriggerConfig = {
  cronExpression: cronExpression
  parallelism: 1
  replicaCompletionCount: 1
}

resource job 'Microsoft.App/jobs@2025-01-01' = {
  name: jobName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${jobIdentityId}': {}
    }
  }
  properties: {
    environmentId: managedEnvironmentId
    workloadProfileName: workloadProfileName
    configuration: {
      triggerType: triggerType
      replicaRetryLimit: replicaRetryLimit
      replicaTimeout: replicaTimeoutSeconds
      manualTriggerConfig: triggerType == 'Manual' ? manualTriggerConfig : null
      scheduleTriggerConfig: triggerType == 'Schedule' ? scheduleTriggerConfig : null
      registries: [
        {
          server: registryLoginServer
          identity: jobIdentityId
        }
      ]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: jobName
          image: imageDigestRef
          command: command
          args: args
          env: concat(nonSecretEnv, secretEnvVars)
        }
      ]
    }
  }
}

output jobId string = job.id
output jobName string = job.name
