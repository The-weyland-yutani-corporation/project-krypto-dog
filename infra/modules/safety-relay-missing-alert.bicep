// Release-owned absence alert for the independently scheduled, non-trading
// durable incident relay. Environment/foundation redeployments do not own this
// resource and therefore cannot reset its activation boundary.
targetScope = 'resourceGroup'

param location string
param environmentName string
param logAnalyticsWorkspaceId string
param actionGroupId string
param safetyIncidentRelayJobName string

@description('Canonical UTC timestamp captured by the exact release that enabled the relay.')
param relayEnabledAt string

param tags object = {}

var encodedRelayEnabledAt = base64(relayEnabledAt)
var runbook = 'https://github.com/The-weyland-yutani-corporation/project-krypto-dog/blob/main/specs/incident-response.md'
var query = format('''
let RelayEnabledAt = todatetime(base64_decode_tostring("{0}"));
let RecentCompleted = toscalar(
  ContainerAppSystemLogs_CL
  | where JobName_s == "{1}"
  | where Reason_s == "Completed"
  | where TimeGenerated >= RelayEnabledAt
  | where TimeGenerated >= ago(15m)
  | count
);
print TimeGenerated=now(), RecentCompleted
| where now() - RelayEnabledAt > 15m and RecentCompleted == 0
''', encodedRelayEnabledAt, safetyIncidentRelayJobName)

resource relayMissingAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-krypto-${environmentName}-safety-relay-missing'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Safety incident relay missing completion'
    description: 'The non-trading durable outbox relay has no successful completion after the exact release activation boundary. Runbook: ${runbook}'
    severity: 0
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
          query: query
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
        signal: 'safety-relay-missing'
        severityClass: 'critical'
        ownerRole: 'PRIMARY_ON_CALL'
        backupRole: 'BACKUP_ON_CALL'
        deduplication: 'safetyRelayJob+releaseActivation'
        acknowledgmentTarget: 'PT5M'
        escalationAfter: 'PT5M'
        runbook: runbook
        relayEnabledAt: relayEnabledAt
      }
    }
    autoMitigate: false
    checkWorkspaceAlertsStorageConfigured: false
    skipQueryValidation: true
  }
}

output alertId string = relayMissingAlert.id
output alertName string = relayMissingAlert.name
