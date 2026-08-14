// Independently deployable schedule-monitoring state. Workflows apply this
// template before enabling schedules and only after disabling/verifying jobs,
// which avoids unsafe partial-state ordering inside one ARM deployment.
targetScope = 'resourceGroup'

@description('Short environment name.')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Azure region for the scheduled query rule.')
param location string

@description('Existing Log Analytics workspace resource ID.')
param logAnalyticsWorkspaceId string = resourceId(
  'Microsoft.OperationalInsights/workspaces',
  'log-krypto-${environmentName}'
)

@description('Existing Action Group resource ID.')
param actionGroupId string = resourceId(
  'Microsoft.Insights/actionGroups',
  'ag-krypto-${environmentName}'
)

@description('Hourly agent-run Container Apps Job name.')
param hourlyJobName string = 'caj-${environmentName}-agent-run'

@description('Whether missing-success monitoring is enabled.')
param enabled bool = false

@description('UTC Unix epoch seconds when this schedule window began. Must be positive whenever enabled=true.')
@minLength(1)
@maxLength(10)
param scheduleEnabledAtUnixSeconds string = '0'

@description('Tags applied to monitoring resources.')
param tags object = {
  project: 'project-krypto'
}

module missingHourlySuccessAlert 'modules/missing-hourly-success-alert.bicep' = {
  name: 'missing-hourly-success-alert'
  params: {
    location: location
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    actionGroupId: actionGroupId
    hourlyJobName: hourlyJobName
    enabled: enabled
    scheduleEnabledAtUnixSeconds: scheduleEnabledAtUnixSeconds
    tags: union(tags, { environment: environmentName })
  }
}

output missingHourlySuccessAlertId string = missingHourlySuccessAlert.outputs.alertId
output missingHourlySuccessAlertName string = missingHourlySuccessAlert.outputs.alertName
output missingHourlySuccessAlertEnabled bool = missingHourlySuccessAlert.outputs.alertEnabled
output scheduleEnabledAtUnixSeconds string = missingHourlySuccessAlert.outputs.scheduleEnabledAtUnixSeconds
