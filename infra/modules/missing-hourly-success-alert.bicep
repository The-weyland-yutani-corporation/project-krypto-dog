// Rollout-owned missing-execution alert. Keeping this out of environment.bicep
// prevents a routine environment redeploy from silently resetting live
// schedule-monitoring state. rollout.bicep deploys this rule before it changes
// the hourly job to Schedule, and disables it when the job returns to Manual.
targetScope = 'resourceGroup'

@description('Azure region for the scheduled query alert rule.')
param location string

@description('Existing per-environment Log Analytics workspace resource ID.')
param logAnalyticsWorkspaceId string

@description('Existing per-environment Action Group resource ID.')
param actionGroupId string

@description('Hourly agent-run Container Apps Job name.')
param hourlyJobName string

@description('Whether the hourly schedule is enabled. False keeps the alert resource deployed but disabled so manual/disabled environments cannot raise missing-trigger alerts.')
param enabled bool = false

@description('UTC Unix epoch seconds when this schedule window began, encoded as a decimal string. Supply the current value whenever enabled=true. The fail-closed default "0" rejects schedule activation if workflow wiring is missing.')
@minLength(1)
@maxLength(10)
param scheduleEnabledAtUnixSeconds string = '0'

@description('Tags applied to the alert rule.')
param tags object = {}

var alertName = 'alert-${hourlyJobName}-missing-success'
var parsedScheduleEnabledAtUnixSeconds = int(scheduleEnabledAtUnixSeconds)
var validatedScheduleEnabledAtUnixSeconds = enabled && parsedScheduleEnabledAtUnixSeconds <= 0
  ? fail('scheduleEnabledAtUnixSeconds must be a positive UTC Unix timestamp when the hourly schedule is enabled.')
  : string(parsedScheduleEnabledAtUnixSeconds)
// base64 makes the deployment-supplied value inert inside KQL. Invalid input
// is rejected by int() above. A timestamp over five minutes in the future
// maps to epoch zero in KQL, which alerts immediately rather than silently
// granting an unbounded monitoring grace period.
var encodedScheduleEnabledAt = base64(validatedScheduleEnabledAtUnixSeconds)

// Query assumptions (Azure Log Analytics destination): direct Container Apps
// environment logging emits legacy ContainerAppSystemLogs_CL with JobName_s,
// Reason_s, Type_s and Log_s, and a successful job execution emits
// Reason_s == "Completed". The explicit project also validates the columns
// consumed by the companion failure alert before Schedule activation.
// Resource-specific ContainerAppSystemLogs/JobName/Reason requires a deliberate
// query migration. On schedule activation validation is NOT skipped, so a
// missing table/schema blocks the dependent rollout instead of scheduling
// unattended work without a functioning absence alert.
var missingHourlySuccessQuery = format('''
let RawScheduleEnabledAt = tolong(base64_decode_tostring("{0}"));
let ParsedScheduleEnabledAt = unixtime_seconds_todatetime(coalesce(RawScheduleEnabledAt, tolong(0)));
let ScheduleEnabledAt = iff(isnull(ParsedScheduleEnabledAt) or ParsedScheduleEnabledAt > now() + 5m, datetime(1970-01-01), ParsedScheduleEnabledAt);
let SuccessfulExecutions =
    ContainerAppSystemLogs_CL
    | where TimeGenerated >= ago(2h)
    | where TimeGenerated >= ScheduleEnabledAt
    | project TimeGenerated, JobName_s, Reason_s, Type_s, Log_s
    | where JobName_s == "{1}" and Reason_s == "Completed"
    | count;
SuccessfulExecutions
| where now() - ScheduleEnabledAt > 2h and Count == 0
| project TimeGenerated = now(), MissingSuccessfulExecutions = 1
''', encodedScheduleEnabledAt, hourlyJobName)

resource missingHourlySuccessAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: alertName
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Hourly agent-run missing successful execution'
    description: 'Alerts when ${hourlyJobName} has no successful execution for more than two hours within the explicitly enabled schedule window.'
    severity: 0
    enabled: enabled
    evaluationFrequency: 'PT5M'
    windowSize: 'PT2H'
    overrideQueryTimeRange: 'PT2H'
    scopes: [
      logAnalyticsWorkspaceId
    ]
    criteria: {
      allOf: [
        {
          query: missingHourlySuccessQuery
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroupId
      ]
      customProperties: {
        signal: 'hourly-agent-run-missing-success'
        hourlyJob: hourlyJobName
        lookback: 'PT2H'
        scheduleEnabledAtUnixSeconds: validatedScheduleEnabledAtUnixSeconds
        severityClass: 'critical'
        ownerRole: 'PRIMARY_ON_CALL'
        backupRole: 'BACKUP_ON_CALL'
        deduplication: 'hourlyJob+scheduleEnabledAtUnixSeconds'
        acknowledgmentTarget: 'PT5M'
        escalationAfter: 'PT5M'
        runbook: 'https://github.com/The-weyland-yutani-corporation/project-krypto-dog/blob/main/specs/incident-response.md'
      }
    }
    autoMitigate: false
    checkWorkspaceAlertsStorageConfigured: false
    skipQueryValidation: !enabled
  }
}

output alertId string = missingHourlySuccessAlert.id
output alertName string = missingHourlySuccessAlert.name
output alertEnabled bool = enabled
output scheduleEnabledAtUnixSeconds string = validatedScheduleEnabledAtUnixSeconds
