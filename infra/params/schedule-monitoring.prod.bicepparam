using '../schedule-monitoring.bicep'

param environmentName = 'prod'
param location = 'westus3'
param namePrefix = 'krypto-prod02'
param enabled = false
param scheduleEnabledAtUnixSeconds = '0'
param tags = {
  project: 'project-krypto'
}
