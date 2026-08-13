// Per-environment Azure Database for PostgreSQL Flexible Server, version
// 17, reachable only over the private delegated subnet (no public
// endpoint). Production gets a CanNotDelete resource lock; dev does not.
targetScope = 'resourceGroup'

@description('Flexible Server name.')
param serverName string

@description('Azure region.')
param location string

@description('Delegated PostgreSQL subnet resource ID.')
param delegatedSubnetId string

@description('Private DNS zone resource ID for privatelink.postgres.database.azure.com.')
param privateDnsZoneId string

@description('Administrator login name.')
param administratorLogin string

@description('Administrator password. Supplied at deploy time; never committed or defaulted.')
@secure()
param administratorLoginPassword string

@description('Compute SKU name, e.g. Standard_B1ms (Burstable) or Standard_D2ds_v5 (General Purpose).')
param skuName string = 'Standard_B1ms'

@description('Compute tier matching skuName, e.g. Burstable or GeneralPurpose.')
param skuTier string = 'Burstable'

@description('Storage size in GiB.')
param storageSizeGB int = 32

@description('Point-in-time-recovery backup retention in days (max operationally required for this stage).')
param backupRetentionDays int = 35

@description('Whether geo-redundant backup is enabled. Creation-time only — cannot be changed after the server exists without recreating it. The approved plan selects this for prod (true) and dev (false).')
param geoRedundantBackupEnabled bool = false

@description('Whether zone-redundant HA is enabled. Deferred per ADR 0008 item 8; single-zone is the accepted initial posture.')
param highAvailabilityEnabled bool = false

@description('Availability zone for the primary replica.')
param availabilityZone string = '1'

@description('Apply a CanNotDelete resource lock (production only).')
param enableDeleteLock bool = false

@description('Tags applied to the server.')
param tags object = {}

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: '17'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      storageSizeGB: storageSizeGB
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackupEnabled ? 'Enabled' : 'Disabled'
    }
    availabilityZone: availabilityZone
    highAvailability: {
      mode: highAvailabilityEnabled ? 'ZoneRedundant' : 'Disabled'
    }
  }
}

resource deleteLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableDeleteLock) {
  scope: server
  name: '${serverName}-delete-lock'
  properties: {
    level: 'CanNotDelete'
    notes: 'Production PostgreSQL Flexible Server holds accounting/trade history; delete requires removing this lock first.'
  }
}

output serverId string = server.id
output serverName string = server.name
output serverFqdn string = server.properties.fullyQualifiedDomainName
