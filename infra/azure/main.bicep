targetScope = 'resourceGroup'

@description('Immutable relay image, including its sha256 digest.')
param image string

@description('Azure region for the relay and its environment.')
param location string = 'centralindia'

param appName string = 'kesami-relay-beta'

@secure()
@description('Server-only KESAMI_* environment settings. Never commit parameter files containing these values.')
param relaySettings object

@secure()
@description('Optional read:packages token for a private GHCR image.')
param registryPassword string = ''

param registryUsername string = 'xenxorowdy'

@description('Monthly budget in the subscription billing currency, not necessarily INR. Zero disables the budget.')
@minValue(0)
param monthlyBudget int = 0

@description('Email recipient for budget alerts. Required when monthlyBudget is positive.')
param budgetEmail string = ''

@description('First day of the budget period, supplied explicitly for repeatable deployments.')
param budgetStartDate string = '2026-10-01'

var settings = items(relaySettings)

resource environment 'Microsoft.App/managedEnvironments@2026-07-01' = {
  name: '${appName}-env'
  location: location
  tags: {
    application: 'kesami'
    stage: 'beta'
  }
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    // Console logs remain available through the log stream without a paid workspace.
    appLogsConfiguration: {
      destination: 'none'
    }
  }
}

resource app 'Microsoft.App/containerApps@2026-07-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  tags: {
    application: 'kesami'
    stage: 'beta'
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 48901
        transport: 'http'
      }
      secrets: concat(map(settings, setting => {
        name: toLower(replace(setting.key, '_', '-'))
        value: setting.value
      }), empty(registryPassword) ? [] : [
        {
          name: 'ghcr-password'
          value: registryPassword
        }
      ])
      registries: empty(registryPassword) ? [] : [
        {
          server: 'ghcr.io'
          username: registryUsername
          passwordSecretRef: 'ghcr-password'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'relay'
          image: image
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: concat([
            {
              name: 'HOST'
              value: '0.0.0.0'
            }
            {
              name: 'PORT'
              value: '48901'
            }
          ], map(settings, setting => {
            name: setting.key
            secretRef: toLower(replace(setting.key, '_', '-'))
          }))
          probes: [for probeType in ['Startup', 'Readiness', 'Liveness']: {
            type: probeType
            httpGet: {
              path: '/health'
              port: 48901
              scheme: 'HTTP'
            }
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: probeType == 'Startup' ? 30 : 3
          }]
        }
      ]
      scale: {
        // Stream accounting and connector OAuth tickets live in this process.
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource budget 'Microsoft.Consumption/budgets@2024-08-01' = if (monthlyBudget > 0) {
  name: '${appName}-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: '${budgetStartDate}T00:00:00Z'
    }
    notifications: {
      half: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [budgetEmail]
      }
      eighty: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [budgetEmail]
      }
      full: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: [budgetEmail]
      }
    }
  }
}

output relayUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output containerAppName string = app.name
output environmentName string = environment.name
