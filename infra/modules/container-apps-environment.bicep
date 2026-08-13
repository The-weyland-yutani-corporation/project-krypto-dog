// Per-environment Container Apps environment on the Consumption workload
// profile, VNet-integrated into the dedicated Container Apps subnet, with
// platform logs sent to the shared Log Analytics workspace.
targetScope = 'resourceGroup'

@description('Container Apps environment name.')
param environmentResourceName string

@description('Azure region.')
param location string

@description('Subnet resource ID for VNet integration (must be the dedicated /27 Container Apps subnet).')
param infrastructureSubnetId string

@description('Log Analytics workspace customer ID (workspace GUID) for platform logs.')
param logAnalyticsCustomerId string

@description('Log Analytics workspace shared key.')
@secure()
param logAnalyticsSharedKey string

@description('Tags applied to the environment.')
param tags object = {}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentResourceName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnetId
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

output environmentId string = managedEnvironment.id
output environmentName string = managedEnvironment.name
output defaultDomain string = managedEnvironment.properties.defaultDomain
output staticIp string = managedEnvironment.properties.staticIp
