/**
 * Live integration test against a real Cumulocity tenant.
 *
 * Credentials are loaded from the gitignored `.env` at the repo root
 * (C8Y_REALTIME_URL / TENANT / USER / PASSWORD). When they are absent (e.g. in
 * CI) the whole suite is skipped, so the default test run stays green.
 *
 * It writes real data (a throwaway managed object) to trigger a notification,
 * then cleans everything up afterwards.
 */
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNotificationClient } from '../../src/index'
import { C8yRest, deleteTestSubscriptions, delay, loadCredentials, purgeMessagingConsumers } from './helpers'
import type { Notification, TenantCredentials } from '../../src/index'

const creds = loadCredentials()
const SUBSCRIPTION = 'c8yRealtimeE2E' // must be alphanumeric
const SUBSCRIBER = 'c8yRealtimeE2EConsumer'

describe.skipIf(!creds)('Notification 2.0 live integration', () => {
  // Fallback keeps the describe callback safe at collection time when skipped.
  const c: TenantCredentials = creds ?? { baseUrl: '', tenant: '', user: '', password: '' }
  const rest = new C8yRest(c)

  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }

  beforeAll(() => {
    process.on('unhandledRejection', onRejection)
  })

  afterAll(async () => {
    process.off('unhandledRejection', onRejection)
    // Delete every created object, the subscription, and the consumer.
    await rest.cleanup()
    await deleteTestSubscriptions(c, [SUBSCRIPTION])
    await purgeMessagingConsumers(c, [SUBSCRIPTION])
    // No unhandled promise rejections should have occurred at any point.
    expect(rejections).toEqual([])
  })

  it('ensures a subscription (idempotent, 409-safe)', async () => {
    const client = createNotificationClient(c)
    const sub = await client.subscriptions.ensure({
      context: 'tenant',
      subscription: SUBSCRIPTION,
      subscriptionFilter: { apis: ['managedobjects'] },
    })
    expect(sub.id).toBeTruthy()
    expect(sub.subscription).toBe(SUBSCRIPTION)

    // A second ensure() must not throw despite the topic already existing.
    const again = await client.subscriptions.ensure({
      context: 'tenant',
      subscription: SUBSCRIPTION,
      subscriptionFilter: { apis: ['managedobjects'] },
    })
    expect(again.id).toBe(sub.id)
    await client.close()
  }, 30_000)

  it('mints a token, receives and acks a real notification, and does not get it redelivered', async () => {
    const client = createNotificationClient(c)

    // 1) Subscribe with explicit ack for deterministic control.
    const consumer = client.subscribe(SUBSCRIPTION, { subscriber: SUBSCRIBER, autoAck: false })

    // Let the WebSocket connect before we generate an event.
    await delay(3000)

    // 2) Write real data to trigger a managedobjects CREATE notification.
    const moId = (await rest.createDevice('c8yRealtimeE2ECreate')).id

    // 3) Receive the notification for our managed object and acknowledge it.
    const received = await waitForNotification(
      consumer,
      (n) => n.action === 'CREATE' && n.description.sourceId === moId,
      20_000,
    )
    expect(received).toBeDefined()
    expect(received?.description.type).toBe('managedobjects')
    expect(received?.ackHeader.length).toBeGreaterThan(0)
    received!.ack()

    // Give the ack time to reach the server, then close this consumer.
    await delay(1500)
    await consumer.close()

    // 4) Reconnect with the SAME subscriber; the acked message must NOT reappear.
    const consumer2 = client.subscribe(SUBSCRIPTION, { subscriber: SUBSCRIBER, autoAck: false })
    const redelivered = await waitForNotification(
      consumer2,
      (n) => n.action === 'CREATE' && n.description.sourceId === moId,
      6000,
    )
    expect(redelivered).toBeUndefined()

    // 5) Close cleanly.
    await consumer2.close()
    await client.close()
  }, 60_000)
})

/**
 * Await the first notification matching `predicate`, or resolve `undefined`
 * after `timeoutMs`. Never rejects. Acks nothing (caller decides).
 * @param consumer
 * @param predicate
 * @param timeoutMs
 */
async function waitForNotification(
  consumer: AsyncIterable<Notification>,
  predicate: (n: Notification) => boolean,
  timeoutMs: number,
): Promise<Notification | undefined> {
  const iterator = consumer[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
  })

  try {
    while (true) {
      const step = await Promise.race([iterator.next(), timeout])
      if (step === undefined || step.done)
        return undefined
      if (predicate(step.value))
        return step.value
    }
  } finally {
    if (timer)
      clearTimeout(timer)
  }
}
