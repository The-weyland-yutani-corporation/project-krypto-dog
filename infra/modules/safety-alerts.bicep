// Independent production-paper safety alerts. These rules inspect external
// Log Analytics evidence, including structured records emitted only after a
// SafetyIncidentOutbox insert commits. They never infer safety from process
// liveness alone and never auto-mitigate an incident.
targetScope = 'resourceGroup'

@description('Azure region for scheduled query rules.')
param location string

@description('Existing per-environment Log Analytics workspace resource ID.')
param logAnalyticsWorkspaceId string

@description('Existing per-environment operator Action Group resource ID.')
param actionGroupId string

@description('Environment suffix used only in deterministic alert names.')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Tags applied to safety alert resources.')
param tags object = {}

var runbook = 'https://github.com/The-weyland-yutani-corporation/project-krypto-dog/blob/main/specs/incident-response.md'
var logSource = '''
union isfuzzy=true
  (ContainerAppConsoleLogs_CL
    | project TimeGenerated, Log = tostring(Log_s)),
  (ContainerAppSystemLogs_CL
    | project TimeGenerated, Log = tostring(Log_s))
| where TimeGenerated >= ago(30m)
'''
var safetyIncidentSource = '''
| where Log contains "[safety-incident]"
    or Log contains "[safety-incident-export]"
| extend SafetyJson = parse_json(substring(Log, indexof(Log, "{")))
| extend IncidentType = tostring(SafetyJson.incidentType),
         IncidentId = tostring(SafetyJson.incidentId),
         EventKind = tostring(SafetyJson.eventKind),
         EventSequence = toint(SafetyJson.eventSequence),
         IncidentStatus = tostring(SafetyJson.status),
         IncidentSeverity = tostring(SafetyJson.severity),
         PendingAgeSeconds = tolong(SafetyJson.pendingAgeSeconds)
| summarize arg_max(TimeGenerated, *) by IncidentId
'''

// Alert custom properties are the executable ownership/escalation contract.
// Human assignments are validated separately by runtime roster/preflight and
// are deliberately not copied into public Bicep or log queries.
var alerts = [
  {
    key: 'route-run-deadline-budget'
    displayName: 'Route or run error, deadline, budget, or provider failure'
    description: 'Any persisted run/provider/deadline/budget incident or structured route failure.'
    severity: 0
    query: '${logSource}\n| where Log contains "\\"eventType\\":\\"route_run_failure\\"" or Log contains "\\"eventType\\":\\"daily_summary_failed\\"" or Log contains "\\"incidentType\\":\\"PROVIDER_FAILURE\\"" or Log contains "\\"incidentType\\":\\"DEADLINE_BUDGET_EXHAUSTION\\""\n| project TimeGenerated, Log'
    signal: 'route-run-deadline-budget'
    owner: 'PRIMARY_ON_CALL'
    backup: 'BACKUP_ON_CALL'
    dedup: 'requestId+agentRunId+incidentId'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'drawdown-lock'
    displayName: 'Paper drawdown lock'
    description: 'Any durable DRAWDOWN_LOCK incident.'
    severity: 0
    query: '${logSource}\n${safetyIncidentSource}\n| where IncidentType == "DRAWDOWN_LOCK" and IncidentStatus != "RESOLVED"\n| project TimeGenerated, IncidentId, IncidentStatus'
    signal: 'drawdown-lock'
    owner: 'PRIMARY_ON_CALL'
    backup: 'BACKUP_ON_CALL'
    dedup: 'incidentId'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'stale-overlapping-lease'
    displayName: 'Stale or overlapping paper run lease'
    description: 'Any durable stale/overlapping lease incident.'
    severity: 0
    query: '${logSource}\n${safetyIncidentSource}\n| where IncidentType == "STALE_OR_OVERLAPPING_LEASE" and IncidentStatus != "RESOLVED"\n| project TimeGenerated, IncidentId, IncidentStatus'
    signal: 'stale-overlapping-lease'
    owner: 'PRIMARY_ON_CALL'
    backup: 'ROLLBACK_OWNER'
    dedup: 'incidentId'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'reconciliation-quarantine'
    displayName: 'Paper reconciliation or quarantine'
    description: 'Any durable reconciliation/quarantine incident.'
    severity: 0
    query: '${logSource}\n${safetyIncidentSource}\n| where IncidentType == "RECONCILIATION_QUARANTINE" and IncidentStatus != "RESOLVED"\n| project TimeGenerated, IncidentId, IncidentStatus'
    signal: 'reconciliation-quarantine'
    owner: 'PRIMARY_ON_CALL'
    backup: 'SAFETY_APPROVER'
    dedup: 'incidentId'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'unexpected-shadow-trade'
    displayName: 'Unexpected shadow trade'
    description: 'Any durable unexpected-shadow-trade incident is an absolute-stop signal.'
    severity: 0
    query: '${logSource}\n${safetyIncidentSource}\n| where IncidentType == "UNEXPECTED_SHADOW_TRADE" and IncidentStatus != "RESOLVED"\n| project TimeGenerated, IncidentId, IncidentStatus'
    signal: 'unexpected-shadow-trade'
    owner: 'PRIMARY_ON_CALL'
    backup: 'ROLLBACK_OWNER'
    dedup: 'incidentId'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'auth-provenance-credential'
    displayName: 'Authentication, provenance, or credential concern'
    description: 'Structured auth/provenance mismatches or durable credential concerns.'
    severity: 0
    query: '${logSource}\n| where Log contains "\\"eventType\\":\\"auth_provenance_mismatch\\"" or Log contains "\\"incidentType\\":\\"AUTH_PROVENANCE_MISMATCH\\"" or Log contains "\\"incidentType\\":\\"CREDENTIAL_CONCERN\\""\n| project TimeGenerated, Log'
    signal: 'auth-provenance-credential'
    owner: 'PRIMARY_ON_CALL'
    backup: 'SAFETY_APPROVER'
    dedup: 'requestId+incidentId+failureCode'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'daily-delivery-failure'
    displayName: 'Daily paper summary delivery failure'
    description: 'Durable ACS/daily-delivery failure or explicit failed route evidence.'
    severity: 1
    query: '${logSource}\n| where Log contains "\\"eventType\\":\\"daily_summary_failed\\"" or Log contains "\\"incidentType\\":\\"EMAIL_DELIVERY_FAILURE\\""\n| project TimeGenerated, Log'
    signal: 'daily-delivery-failure'
    owner: 'PRIMARY_ON_CALL'
    backup: 'BACKUP_ON_CALL'
    dedup: 'requestId+incidentId'
    acknowledge: 'PT15M'
    escalate: 'PT15M'
  }
  {
    key: 'critical-daily-delivery-failure'
    displayName: 'Critical paper alert-channel delivery failure'
    description: 'A durable critical ACS/email delivery incident.'
    severity: 0
    query: '${logSource}\n${safetyIncidentSource}\n| where IncidentType == "EMAIL_DELIVERY_FAILURE" and IncidentSeverity == "CRITICAL" and IncidentStatus != "RESOLVED"\n| project TimeGenerated, IncidentId, IncidentStatus'
    signal: 'critical-daily-delivery-failure'
    owner: 'PRIMARY_ON_CALL'
    backup: 'BACKUP_ON_CALL'
    dedup: 'incidentId'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'journal-written-false'
    displayName: 'Paper run journalWritten false'
    description: 'Journal persistence failure or a durable post-commit failure.'
    severity: 0
    query: '${logSource}\n| where Log contains "\\"eventType\\":\\"journal_persistence_failed\\"" or Log contains "\\"incidentType\\":\\"JOURNAL_FAILURE\\"" or Log contains "\\"incidentType\\":\\"POST_COMMIT_FAILURE\\""\n| project TimeGenerated, Log'
    signal: 'journal-written-false'
    owner: 'PRIMARY_ON_CALL'
    backup: 'EVIDENCE_CUSTODIAN'
    dedup: 'agentRunId+transactionId+incidentId'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'persisted-post-commit-failure'
    displayName: 'Persisted paper post-commit obligation failure'
    description: 'Any unresolved durable POST_COMMIT_FAILURE or TELEMETRY_FAILURE incident.'
    severity: 0
    query: '${logSource}\n${safetyIncidentSource}\n| where IncidentType in ("POST_COMMIT_FAILURE", "TELEMETRY_FAILURE") and IncidentStatus != "RESOLVED"\n| project TimeGenerated, IncidentId, IncidentStatus, IncidentType'
    signal: 'persisted-post-commit-failure'
    owner: 'PRIMARY_ON_CALL'
    backup: 'EVIDENCE_CUSTODIAN'
    dedup: 'incidentId'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'readiness-capacity'
    displayName: 'Readiness or admission capacity failure'
    description: 'Any externally observed readiness or admission-capacity failure.'
    severity: 1
    query: '${logSource}\n| where Log contains "\\"eventType\\":\\"readiness_capacity_failure\\"" or Log contains "\\"incidentType\\":\\"READINESS_CAPACITY_FAILURE\\""\n| project TimeGenerated, Log'
    signal: 'readiness-capacity'
    owner: 'PRIMARY_ON_CALL'
    backup: 'RELEASE_OWNER'
    dedup: 'deploymentId+failureCode'
    acknowledge: 'PT15M'
    escalate: 'PT15M'
  }
  {
    key: 'sustained-readiness-critical'
    displayName: 'Sustained readiness failure'
    description: 'Readiness has remained failed beyond the critical SLO.'
    severity: 0
    query: '${logSource}\n| where Log contains "\\"eventType\\":\\"readiness_capacity_failure\\""\n| summarize FirstFailure=min(TimeGenerated), LastFailure=max(TimeGenerated), Failures=count()\n| where FirstFailure <= ago(5m) and LastFailure >= ago(5m)\n| project TimeGenerated=LastFailure, FirstFailure, Failures'
    signal: 'sustained-readiness-critical'
    owner: 'PRIMARY_ON_CALL'
    backup: 'RELEASE_OWNER'
    dedup: 'deploymentId+readiness-critical'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'critical-ack-escalation'
    displayName: 'Critical incident acknowledgment overdue'
    description: 'An externally exported critical incident remains OPEN past its acknowledgment target.'
    severity: 0
    query: '${logSource}\n${safetyIncidentSource}\n| where IncidentSeverity == "CRITICAL" and IncidentStatus == "OPEN" and PendingAgeSeconds >= 300\n| project TimeGenerated, IncidentId, PendingAgeSeconds'
    signal: 'critical-ack-escalation'
    owner: 'BACKUP_ON_CALL'
    backup: 'SAFETY_APPROVER'
    dedup: 'incidentId+critical-ack-overdue'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
  {
    key: 'warning-ack-escalation'
    displayName: 'Warning incident acknowledgment overdue'
    description: 'An externally exported warning incident remains OPEN past its acknowledgment target.'
    severity: 1
    query: '${logSource}\n${safetyIncidentSource}\n| where IncidentSeverity == "WARNING" and IncidentStatus == "OPEN" and PendingAgeSeconds >= 900\n| project TimeGenerated, IncidentId, PendingAgeSeconds'
    signal: 'warning-ack-escalation'
    owner: 'BACKUP_ON_CALL'
    backup: 'RELEASE_OWNER'
    dedup: 'incidentId+warning-ack-overdue'
    acknowledge: 'PT15M'
    escalate: 'PT15M'
  }
  {
    key: 'warning-test-fire'
    displayName: 'Non-trading warning test fire'
    description: 'Explicit attended warning drill evidence; never a trading invocation.'
    severity: 2
    query: '${logSource}\n${safetyIncidentSource}\n| where IncidentType == "TEST_FIRE_WARNING" and IncidentStatus != "RESOLVED"\n| project TimeGenerated, IncidentId, IncidentStatus'
    signal: 'warning-test-fire'
    owner: 'PRIMARY_ON_CALL'
    backup: 'BACKUP_ON_CALL'
    dedup: 'incidentId'
    acknowledge: 'PT15M'
    escalate: 'PT15M'
  }
  {
    key: 'critical-test-fire'
    displayName: 'Non-trading critical test fire'
    description: 'Explicit attended critical drill evidence; never a trading invocation.'
    severity: 0
    query: '${logSource}\n${safetyIncidentSource}\n| where IncidentType == "TEST_FIRE_CRITICAL" and IncidentStatus != "RESOLVED"\n| project TimeGenerated, IncidentId, IncidentStatus'
    signal: 'critical-test-fire'
    owner: 'PRIMARY_ON_CALL'
    backup: 'BACKUP_ON_CALL'
    dedup: 'incidentId'
    acknowledge: 'PT5M'
    escalate: 'PT5M'
  }
]

resource safetyAlerts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [
  for alert in alerts: {
    name: 'alert-krypto-${environmentName}-${alert.key}'
    location: location
    tags: tags
    kind: 'LogAlert'
    properties: {
      displayName: alert.displayName
      description: '${alert.description} Runbook: ${runbook}'
      severity: alert.severity
      enabled: true
      evaluationFrequency: 'PT5M'
      windowSize: 'PT30M'
      overrideQueryTimeRange: 'PT30M'
      scopes: [
        logAnalyticsWorkspaceId
      ]
      criteria: {
        allOf: [
          {
            query: alert.query
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
          signal: alert.signal
          severityClass: alert.severity == 0 ? 'critical' : 'warning'
          ownerRole: alert.owner
          backupRole: alert.backup
          deduplication: alert.dedup
          acknowledgmentTarget: alert.acknowledge
          escalationAfter: alert.escalate
          runbook: runbook
        }
      }
      autoMitigate: false
      checkWorkspaceAlertsStorageConfigured: false
      // Foundation creation can precede the first console-log row. The exact
      // release/target smoke must prove query schema and delivery before #75.
      skipQueryValidation: true
    }
  }
]

output alertIds array = [
  for index in range(0, length(alerts)): safetyAlerts[index].id
]
output alertNames array = [
  for index in range(0, length(alerts)): safetyAlerts[index].name
]
