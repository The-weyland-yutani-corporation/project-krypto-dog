// Per-environment Action Group and Azure Monitor alerts for the two
// scheduler Container Apps Jobs. The Log Analytics workspace itself is
// created directly in environment.bicep (not as a module) so its listKeys()
// shared key can be read in the same template that creates it, without an
// "existing" cross-module lookup (Bicep cannot evaluate listKeys() on an
// existing resource whose name comes from a module output).
targetScope = 'resourceGroup'

@description('Azure region for the scheduled query alert rules.')
param location string

@description('Action Group name.')
param actionGroupName string

@description('Short name shown in alert notifications (max 12 chars).')
@maxLength(12)
param actionGroupShortName string

@description('Email addresses that receive operator alerts.')
param alertEmails array

@description('Existing per-environment Log Analytics workspace resource ID.')
param logAnalyticsWorkspaceId string

@description('Hourly agent-run Container Apps Job name.')
param hourlyJobName string

@description('Daily summary Container Apps Job name.')
param dailyJobName string

@description('Tags applied to all monitoring resources.')
param tags object = {}

var failedJobExecutionAlertName = 'alert-${hourlyJobName}-or-${dailyJobName}-failed'

// Query assumptions (Azure Log Analytics destination): Container Apps emits
// legacy ContainerAppSystemLogs_CL with JobName_s, Reason_s, Type_s and Log_s;
// ProcessExited carries the process exit code. Workspaces using resource-specific
// ContainerAppSystemLogs/JobName/Reason/Type/Log need an intentional query
// migration before these rules are enabled. skipQueryValidation is required
// on initial environment creation because the _CL table is created only after
// the first Container Apps log reaches the new workspace.
var failedJobExecutionQuery = format('''
ContainerAppSystemLogs_CL
| where TimeGenerated >= ago(15m)
| where JobName_s in ("{0}", "{1}")
| extend ExitCode = toint(extract(@"exit code:?\s*'?(-?\d+)'?", 1, tolower(Log_s)))
| where Reason_s in~ ("Failed", "BackoffLimitExceeded", "DeadlineExceeded")
    or (Reason_s =~ "ProcessExited" and isnotnull(ExitCode) and ExitCode != 0)
    or Log_s contains "execution failed"
    or Log_s contains "backoff limit exceeded"
    or Log_s contains "deadline exceeded"
| project TimeGenerated, JobName = JobName_s, Reason = Reason_s, Type = Type_s, Log = Log_s
''', hourlyJobName, dailyJobName)

resource actionGroup 'microsoft.insights/actiongroups@2023-01-01' = {
  name: actionGroupName
  location: 'global'
  tags: tags
  properties: {
    groupShortName: actionGroupShortName
    enabled: true
    emailReceivers: [
      for email in alertEmails: {
        name: 'operator-${uniqueString(email)}'
        emailAddress: email
        useCommonAlertSchema: true
      }
    ]
  }
}

resource failedJobExecutionAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: failedJobExecutionAlertName
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Container Apps scheduler job execution failed'
    description: 'Alerts when the ${hourlyJobName} or ${dailyJobName} Container Apps Job emits a terminal failure signal.'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    overrideQueryTimeRange: 'PT15M'
    scopes: [
      logAnalyticsWorkspaceId
    ]
    criteria: {
      allOf: [
        {
          query: failedJobExecutionQuery
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          dimensions: [
            {
              name: 'JobName'
              operator: 'Include'
              values: [
                '*'
              ]
            }
          ]
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
      customProperties: {
        signal: 'container-apps-job-failed'
        hourlyJob: hourlyJobName
        dailyJob: dailyJobName
      }
    }
    autoMitigate: true
    checkWorkspaceAlertsStorageConfigured: false
    skipQueryValidation: true
  }
}

output actionGroupId string = actionGroup.id
output failedJobExecutionAlertId string = failedJobExecutionAlert.id
output failedJobExecutionAlertName string = failedJobExecutionAlert.name
