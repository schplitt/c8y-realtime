/**
 * Live integration test exercising CREATE / UPDATE / DELETE across ALL
 * Notification 2.0 types using the high-level {@link createRealtimeClient} API.
 *
 * It drives real platform activity (managed objects, measurements, events,
 * alarms, operations) and asserts that the corresponding typed notifications are
 * delivered. Everything created is cleaned up.
 *
 * A single realtime client is used with two scopes: a tenant firehose
 * (`onAny`) captures managedobjects CREATE + tenant-wide alarms/events/
 * operations, and a device firehose (`onAny(deviceId)`) captures measurements +
 * managed-object UPDATE/DELETE for that device. Registering the device scope
 * transparently opens its own `mo` subscription.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createRealtimeClient } from '../../src/index'
import { C8yRest, deleteTestSubscriptions, delay, loadCredentials, purgeMessagingConsumers } from './helpers'
import type { Notification, RealtimeClient, TenantCredentials } from '../../src/index'

const creds = loadCredentials()
const BASE = 'c8yRtCrud'

describe.skipIf(!creds)('Notification 2.0 live — CRUD across all types', () => {
  const c: TenantCredentials = creds ?? { baseUrl: '', tenant: '', user: '', password: '' }
  const rest = new C8yRest(c)

  // Robust teardown: delete every object created during the test (even on
  // failure) and remove every subscription this suite opened (names start BASE).
  afterAll(async () => {
    const failed = await rest.cleanup()
    if (failed.length > 0)
      console.warn('[crud] could not delete:', failed)
    await deleteTestSubscriptions(c, [BASE]) // subscription resources
    await purgeMessagingConsumers(c, [BASE]) // the lingering consumer(s)
  })

  it('receives create/update/delete notifications for every type', async () => {
    const seen = new Set<string>() // "type:ACTION"
    const seenSource = new Set<string>() // "type:ACTION:sourceId"
    const record = (n: Notification): void => {
      const combo = `${n.description.type}:${n.action.toUpperCase()}`
      seen.add(combo)
      if (n.description.sourceId)
        seenSource.add(`${combo}:${n.description.sourceId}`)
    }
    const waitForSource = async (key: string, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (seenSource.has(key))
          return true
        await delay(250)
      }
      return false
    }

    const rt: RealtimeClient = createRealtimeClient({ ...c, name: BASE })

    // 1) Tenant firehose: managedobjects CREATE + tenant-wide alarms/events/ops.
    rt.onAny((_p, n) => record(n))
    await rt.start()

    // 2) Warm up: a fresh persistent subscription only retains from its first
    //    connect, so create devices until one is actually delivered — proving
    //    the tenant consumer is live. That device becomes our subject.
    let device: { id: string } | undefined
    const tenantDeadline = Date.now() + 40_000
    while (!device && Date.now() < tenantDeadline) {
      const candidate = await rest.createDevice('c8yRealtimeCrudDevice')
      if (await waitForSource(`managedobjects:CREATE:${candidate.id}`, 5000))
        device = candidate
    }
    if (!device)
      throw new Error('tenant consumer never delivered managedobjects:CREATE')

    // 3) Device firehose: measurements + MO UPDATE/DELETE for this device. Warm
    //    it up the same way with measurements (which also covers CREATE+DELETE).
    rt.onAny(device.id, (_p, n) => record(n))
    await rt.start()
    // The mo subscription's forwarding takes a moment to activate after ensure;
    // let it settle before trusting the warmup, then confirm liveness.
    await delay(4000)
    // Note: a measurement notification's description sourceId is the DEVICE id
    // (its source), not the measurement's own id.
    let moLive = false
    const moDeadline = Date.now() + 40_000
    while (!moLive && Date.now() < moDeadline) {
      const m = await rest.createMeasurement(device.id)
      moLive = await waitForSource(`measurements:CREATE:${device.id}`, 6000)
      await rest.deleteMeasurement(m.id).catch(() => {}) // → measurements:DELETE
    }
    if (!moLive)
      throw new Error('device consumer never delivered measurements:CREATE')

    // 4) Drive the remaining create/update/delete. Risky deletes are best-effort.
    const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn()
      } catch (error) {
        console.warn(`[crud] ${label} failed:`, (error as Error).message)
      }
      await delay(600)
    }

    await step('mo:update', () => rest.updateDevice(device.id, { c8y_Note: 'updated' }))

    const event = await rest.createEvent(device.id)
    await delay(600)
    await step('event:update', () => rest.updateEvent(event.id))
    await step('event:delete', () => rest.deleteEvent(event.id))

    const alarm = await rest.createAlarm(device.id)
    await delay(600)
    await step('alarm:update', () => rest.updateAlarm(alarm.id))

    const operation = await rest.createOperation(device.id)
    await delay(600)
    await step('operation:update', () => rest.updateOperation(operation.id))
    await step('operation:delete', () => rest.deleteOperation(operation.id))

    await step('alarm:delete', () => rest.deleteAlarmsBySource(device.id))

    // Delete the device last (also emits managedobjects DELETE).
    await step('mo:delete', () => rest.deleteDevice(device.id))

    // Every CRUD combination the platform actually supports. Two deliberate
    // omissions, verified live against the tenant:
    //   - operations:DELETE — Cumulocity returns HTTP 405 (operations are not
    //     deletable); it is attempted above as best-effort.
    //   - alarms:DELETE — alarms are CLEARED via UPDATE, never deleted, so no
    //     DELETE notification is emitted.
    // With the device firehose using apis ['*'], alarmsWithChildren /
    // eventsWithChildren also arrive and are covered incidentally.
    const expected = [
      'managedobjects:CREATE',
      'managedobjects:UPDATE',
      'managedobjects:DELETE',
      'measurements:CREATE',
      'measurements:DELETE',
      'events:CREATE',
      'events:UPDATE',
      'events:DELETE',
      'alarms:CREATE',
      'alarms:UPDATE',
      'operations:CREATE',
      'operations:UPDATE',
    ]

    // Poll until every expected combo has arrived (delivery latency varies),
    // up to a generous timeout.
    const deadline = Date.now() + 20_000
    while (expected.some((combo) => !seen.has(combo)) && Date.now() < deadline)
      await delay(500)

    await rt.close()
    console.warn('[crud] observed notifications:', [...seen].sort())

    for (const combo of expected)
      expect(seen, `expected to receive ${combo}; got ${[...seen].sort().join(', ')}`).toContain(combo)
  }, 120_000)
})
