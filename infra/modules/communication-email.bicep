// Per-environment Azure Communication Services Email resources. The
// Azure-managed domain avoids custom DNS while preserving a real provider
// delivery gate for target smoke.
targetScope = 'resourceGroup'

@description('Globally unique Azure Communication Services resource name.')
param communicationServiceName string

@description('Email Communication Service resource name.')
param emailServiceName string

@description('Tags applied to all communication resources.')
param tags object = {}

resource emailService 'Microsoft.Communication/emailServices@2025-09-01' = {
  name: emailServiceName
  location: 'global'
  tags: tags
  properties: {
    dataLocation: 'United States'
  }
}

resource azureManagedDomain 'Microsoft.Communication/emailServices/domains@2025-09-01' = {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  tags: tags
  properties: {
    domainManagement: 'AzureManaged'
    userEngagementTracking: 'Disabled'
  }
}

resource communicationService 'Microsoft.Communication/communicationServices@2025-09-01' = {
  name: communicationServiceName
  location: 'global'
  tags: tags
  properties: {
    dataLocation: 'United States'
    disableLocalAuth: false
    linkedDomains: [
      azureManagedDomain.id
    ]
    publicNetworkAccess: 'Enabled'
  }
}

output communicationServiceId string = communicationService.id
output communicationServiceName string = communicationService.name
output communicationServiceEndpoint string = 'https://${communicationService.name}.communication.azure.com'
output communicationEmailSender string = 'DoNotReply@${azureManagedDomain.properties.mailFromSenderDomain}'
