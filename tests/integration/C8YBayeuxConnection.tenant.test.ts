import { describe, expect, it } from 'vitest'
import { C8YBayeuxConnection } from '../../src/bayeux/C8YBayeuxConnection'
import { getTenantIntegrationConfig, hasTenantIntegrationEnv } from './tenant'

describe('C8YBayeuxConnection real tenant integration', () => {
  it.skipIf(!hasTenantIntegrationEnv())('subscribes through the real C8YBayeuxConnection against a configured tenant', async () => {
    const tenant = getTenantIntegrationConfig()
    const connection = new C8YBayeuxConnection({
      auth: tenant.auth,
      url: tenant.url,
    })

    try {
      await connection.subscribe('/inventory/*')
      await expect(connection.isConnected).resolves.toBe(true)
      await connection.unsubscribe('/inventory/*')
    } finally {
      await connection.disconnect()
    }
  })
})
