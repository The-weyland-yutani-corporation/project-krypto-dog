// Per-environment networking: a /24 VNet with two dedicated /27 subnets
// (Container Apps workload-profile environment, delegated PostgreSQL
// Flexible Server) plus the private DNS zone PostgreSQL requires for
// private access. No public endpoints are created here.
targetScope = 'resourceGroup'

@description('Azure region for all networking resources.')
param location string

@description('Resource name prefix, e.g. krypto-dev or krypto-prod.')
param namePrefix string

@description('VNet address space. Must be a /24 to fit the two required /27 subnets with room to spare.')
param vnetAddressPrefix string = '10.20.0.0/24'

@description('Container Apps workload-profile subnet address prefix. Must be a /27 (Container Apps environment VNet integration requires /27 minimum).')
param containerAppsSubnetPrefix string = '10.20.0.0/27'

@description('Delegated PostgreSQL Flexible Server subnet address prefix. Must be a /27.')
param postgresSubnetPrefix string = '10.20.0.32/27'

@description('Tags applied to all networking resources.')
param tags object = {}

var vnetName = 'vnet-${namePrefix}'
var containerAppsSubnetName = 'snet-container-apps'
var postgresSubnetName = 'snet-postgres'
var postgresPrivateDnsZoneName = 'privatelink.postgres.database.azure.com'

resource vnet 'Microsoft.Network/virtualNetworks@2025-01-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: containerAppsSubnetName
        properties: {
          addressPrefix: containerAppsSubnetPrefix
          delegations: [
            {
              name: 'Microsoft.App.environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: postgresSubnetName
        properties: {
          addressPrefix: postgresSubnetPrefix
          delegations: [
            {
              name: 'Microsoft.DBforPostgreSQL.flexibleServers'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }
}

resource containerAppsSubnet 'Microsoft.Network/virtualNetworks/subnets@2025-01-01' existing = {
  parent: vnet
  name: containerAppsSubnetName
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2025-01-01' existing = {
  parent: vnet
  name: postgresSubnetName
}

resource postgresPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: postgresPrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource postgresPrivateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresPrivateDnsZone
  name: 'link-${vnetName}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output containerAppsSubnetId string = containerAppsSubnet.id
output postgresSubnetId string = postgresSubnet.id
output postgresPrivateDnsZoneId string = postgresPrivateDnsZone.id
output postgresPrivateDnsZoneName string = postgresPrivateDnsZone.name
