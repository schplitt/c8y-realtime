import { describe, expect, it } from 'vitest'
import { createNotificationClient, NotificationClient } from '../../src/client'
import { MockSocket, waitFor } from './mock-socket'
import type { WebSocketFactory } from '../../src/types'

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
