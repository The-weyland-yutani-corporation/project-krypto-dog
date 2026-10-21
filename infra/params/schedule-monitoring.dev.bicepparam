using '../schedule-monitoring.bicep'

param environmentName = 'dev'
param location = 'westus3'
param namePrefix = 'krypto-dev02'
param enabled = false
param scheduleEnabledAtUnixSeconds = '0'
param tags = {
  project: 'project-krypto'
}
