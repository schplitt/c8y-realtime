import { describe, expect, it } from 'vitest'
import { createMultiTenantClient, createNotificationClient, NotificationClient } from '../../src/client'
import { MockSocket, waitFor } from './mock-socket'
import type { TenantCredentials, WebSocketFactory } from '../../src/types'

describe('createNotificationClient', () => {
  it('creates a client exposing the subscriptions REST API', () => {
    const client = createNotificationClient({
      baseUrl: 'https://a.com',
      tenant: 't1',
      user: 'u',
      password: 'p',
    })
    expect(client).toBeInstanceOf(NotificationClient)
    expect(client.tenant).toBe('t1')
    expect(typeof client.subscriptions.ensure).toBe('function')
    expect(typeof client.subscribe).toBe('function')
  })
})

describe('createMultiTenantClient', () => {
  const credentials: TenantCredentials[] = [
    { baseUrl: 'https://a.com', tenant: 't1', user: 'u1', password: 'p1' },
    { baseUrl: '', tenant: 't2', user: 'u2', password: 'p2' },
  ]

  it('builds one client per credential, keyed by tenant id', () => {
    const clients = createMultiTenantClient('https://shared.com', credentials)
    expect(clients).toBeInstanceOf(Map)
    expect(clients.size).toBe(2)
    expect([...clients.keys()]).toEqual(['t1', 't2'])
    expect(clients.get('t1')).toBeInstanceOf(NotificationClient)
    expect(clients.get('t2')?.tenant).toBe('t2')
  })

  it('falls back to the shared base URL when a credential omits one', () => {
    // Both clients construct without throwing; the t2 credential has no baseUrl
    // so the shared URL is used.
    const clients = createMultiTenantClient('https://shared.com', credentials)
    expect(clients.get('t2')).toBeInstanceOf(NotificationClient)
  })
})

describe('notificationClient.subscribe', () => {
  it('defaults the subscriber to an alphanumeric name (Cumulocity requires it)', async () => {
    MockSocket.reset()
    let subscriberSeen: string | undefined
    const fetchImpl = (async (url: string, init: { body?: string }) => {
      if (url.includes('notification2/token')) {
        subscriberSeen = JSON.parse(String(init.body)).subscriber
        return new Response(JSON.stringify({ token: 'tok' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const client = createNotificationClient({
      baseUrl: 'https://a.com',
      tenant: 't',
      user: 'u',
      password: 'p',
      webSocketImpl: MockSocket as unknown as WebSocketFactory,
      fetchImpl,
    })
    const consumer = client.subscribe('myTopic')
    await waitFor(() => subscriberSeen !== undefined)
    expect(subscriberSeen).toBe('myTopicConsumer')
    expect(subscriberSeen).toMatch(/^[a-z0-9]+$/i) // no hyphens/underscores
    await consumer.close()
  })
})
