// Per-environment Action Group for operator alert delivery. The Log
// Analytics workspace itself is created directly in environment.bicep
// (not as a module) so its listKeys() shared key can be read in the same
// template that creates it, without an "existing" cross-module lookup
// (Bicep cannot evaluate listKeys() on an existing resource whose name
// comes from a module output).
targetScope = 'resourceGroup'

@description('Action Group name.')
param actionGroupName string

@description('Short name shown in alert notifications (max 12 chars).')
@maxLength(12)
param actionGroupShortName string

@description('Email addresses that receive operator alerts.')
param alertEmails array

@description('Tags applied to the Action Group.')
param tags object = {}

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

output actionGroupId string = actionGroup.id
