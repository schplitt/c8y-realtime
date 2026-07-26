/**
 * Shared helpers for the live e2e tests: credential loading and a minimal
 * Cumulocity REST client used purely to *trigger* notifications (create/update/
 * delete of managed objects, measurements, events, alarms and operations).
 *
 * This intentionally uses native `fetch` only — the SDK under test implements
 * Notification 2.0 itself; these helpers just generate real platform activity.
 */
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createNotificationClient } from '../../src/index'
import type { TenantCredentials } from '../../src/index'

export function loadCredentials(): TenantCredentials | undefined {
  if (!process.env.C8Y_REALTIME_URL) {
    try {
      process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)))
    } catch {
      // no .env present
    }
  }
  const baseUrl = process.env.C8Y_REALTIME_URL
  const tenant = process.env.C8Y_REALTIME_TENANT
  const user = process.env.C8Y_REALTIME_USER
  const password = process.env.C8Y_REALTIME_PASSWORD
  if (!baseUrl || !tenant || !user || !password)
    return undefined
  return { baseUrl, tenant, user, password }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Delete every subscription whose name starts with one of `prefixes`
 * (best-effort). Also sweeps any left over from earlier runs, so no test
 * subscriptions linger on the tenant.
 * @param creds
 * @param prefixes
 */
export async function deleteTestSubscriptions(creds: TenantCredentials, prefixes: string[]): Promise<void> {
  const client = createNotificationClient(creds)
  try {
    const { subscriptions } = await client.subscriptions.list({ pageSize: 200 }).catch(() => ({ subscriptions: [] }))
    for (const sub of subscriptions) {
      if (prefixes.some((prefix) => sub.subscription.startsWith(prefix)))
        await client.subscriptions.delete(sub.id).catch(() => {})
    }
  } finally {
    await client.close()
  }
}

/**
 * Delete lingering CONSUMERS (subscribers) from the Messaging Service for any
 * topic whose name starts with one of `prefixes`, via the messaging-management
 * admin API. Deleting notification2 subscriptions does NOT remove consumers, so
 * tests use this to leave nothing behind. Best-effort; never throws.
 * @param creds
 * @param prefixes
 */
export async function purgeMessagingConsumers(creds: TenantCredentials, prefixes: string[]): Promise<void> {
  const base = creds.baseUrl.replace(/\/+$/, '')
  const authHeader = `Basic ${Buffer.from(`${creds.tenant}/${creds.user}:${creds.password}`).toString('base64')}`
  const mm = `${base}/service/messaging-management/tenants/${creds.tenant}/namespaces/relnotif`
  const headers = { Authorization: authHeader, Accept: 'application/json' }
  const matches = (name: string): boolean => prefixes.some((prefix) => name.startsWith(prefix))

  const deleteSubscriber = async (topic: string, subscriber: string): Promise<void> => {
    await fetch(
      `${mm}/topics/${encodeURIComponent(topic)}/types/persistent/subscribers/${encodeURIComponent(subscriber)}`,
      { method: 'DELETE', headers: { Authorization: authHeader } },
    ).catch(() => {})
  }

  const topicsRes = await fetch(`${mm}/topics?pageSize=1000`, { headers }).catch(() => undefined)
  if (!topicsRes?.ok)
    return
  const { topics = [] } = await topicsRes.json() as { topics?: Array<{ name: string }> }
  for (const topic of topics) {
    if (!matches(topic.name))
      continue
    // The subscriber list can be eventually-consistent right after a client
    // disconnects, so also delete the conventional `<topic>Consumer` directly.
    await deleteSubscriber(topic.name, `${topic.name}Consumer`)
    const subsRes = await fetch(`${mm}/topics/${encodeURIComponent(topic.name)}/types/persistent/subscribers?pageSize=1000`, { headers }).catch(() => undefined)
    if (!subsRes?.ok)
      continue
    const { subscribers = [] } = await subsRes.json() as { subscribers?: Array<{ name: string }> }
    for (const sub of subscribers)
      await deleteSubscriber(topic.name, sub.name)
  }
}

interface IdObject { id: string }

type ResourceKind = 'managedObject' | 'measurement' | 'event' | 'operation' | 'alarm'

const DELETE_PATH: Partial<Record<ResourceKind, (id: string) => string>> = {
  // Deleting a managed object cascades to its measurements/events/alarms/operations.
  managedObject: (id) => `/inventory/managedObjects/${id}`,
  measurement: (id) => `/measurement/measurements/${id}`,
  event: (id) => `/event/events/${id}`,
  // Alarms cannot be deleted individually (cleared via UPDATE); operations
  // cannot be deleted (405). Both are removed when their device is deleted.
}

/**
 * A tiny authenticated REST client for the core Cumulocity domain APIs.
 *
 * Every object it creates is tracked so {@link C8yRest.cleanup} can remove all
 * of them in `afterAll`, even if a test fails part-way through — leaving no
 * leftover resources on the tenant.
 */
export class C8yRest {
  readonly #base: string
  readonly #auth: string
  readonly #created: Array<{ kind: ResourceKind, id: string }> = []

  constructor(creds: TenantCredentials) {
    this.#base = creds.baseUrl.replace(/\/+$/, '')
    this.#auth = `Basic ${Buffer.from(`${creds.tenant}/${creds.user}:${creds.password}`).toString('base64')}`
  }

  async #req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.#base}${path}`, {
      method,
      headers: {
        'Authorization': this.#auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok)
      throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  async #create(kind: ResourceKind, path: string, body: unknown): Promise<IdObject> {
    const created = await this.#req<IdObject>('POST', path, body)
    if (created?.id)
      this.#created.push({ kind, id: created.id })
    return created
  }

  #untrack(id: string): void {
    const index = this.#created.findIndex((r) => r.id === id)
    if (index !== -1)
      this.#created.splice(index, 1)
  }

  // ── inventory ──
  createDevice(name: string): Promise<IdObject> {
    return this.#create('managedObject', '/inventory/managedObjects', { name, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} })
  }

  updateDevice(id: string, patch: Record<string, unknown>): Promise<IdObject> {
    return this.#req('PUT', `/inventory/managedObjects/${id}`, patch)
  }

  deleteDevice(id: string): Promise<void> {
    this.#untrack(id)
    return this.#req('DELETE', `/inventory/managedObjects/${id}`)
  }

  // ── measurements ──
  createMeasurement(deviceId: string): Promise<IdObject> {
    return this.#create('measurement', '/measurement/measurements', {
      source: { id: deviceId },
      time: new Date().toISOString(),
      type: 'c8yRealtimeTestMeasurement',
      c8y_Temperature: { T: { value: 21, unit: 'C' } },
    })
  }

  deleteMeasurement(id: string): Promise<void> {
    this.#untrack(id)
    return this.#req('DELETE', `/measurement/measurements/${id}`)
  }

  // ── events ──
  createEvent(deviceId: string): Promise<IdObject> {
    return this.#create('event', '/event/events', {
      source: { id: deviceId },
      type: 'c8yRealtimeTestEvent',
      text: 'created',
      time: new Date().toISOString(),
    })
  }

  updateEvent(id: string): Promise<IdObject> {
    return this.#req('PUT', `/event/events/${id}`, { text: 'updated' })
  }

  deleteEvent(id: string): Promise<void> {
    this.#untrack(id)
    return this.#req('DELETE', `/event/events/${id}`)
  }

  // ── alarms ──
  createAlarm(deviceId: string): Promise<IdObject> {
    return this.#create('alarm', '/alarm/alarms', {
      source: { id: deviceId },
      type: 'c8yRealtimeTestAlarm',
      text: 'created',
      severity: 'MINOR',
      status: 'ACTIVE',
      time: new Date().toISOString(),
    })
  }

  updateAlarm(id: string): Promise<IdObject> {
    return this.#req('PUT', `/alarm/alarms/${id}`, { status: 'CLEARED', severity: 'WARNING' })
  }

  deleteAlarmsBySource(deviceId: string): Promise<void> {
    return this.#req('DELETE', `/alarm/alarms?source=${deviceId}`)
  }

  // ── operations ──
  createOperation(deviceId: string): Promise<IdObject> {
    return this.#create('operation', '/devicecontrol/operations', {
      deviceId,
      description: 'c8y-realtime test operation',
      c8y_Restart: {},
    })
  }

  updateOperation(id: string): Promise<IdObject> {
    return this.#req('PUT', `/devicecontrol/operations/${id}`, { status: 'EXECUTING' })
  }

  deleteOperation(id: string): Promise<void> {
    return this.#req('DELETE', `/devicecontrol/operations/${id}`)
  }

  /**
   * Best-effort deletion of every tracked object. Deletes children before the
   * managed objects that would cascade them, and never throws. Returns the ids
   * that could not be deleted (for diagnostics).
   */
  async cleanup(): Promise<string[]> {
    const failed: string[] = []
    // Children first, managed objects (which cascade) last.
    const order: ResourceKind[] = ['measurement', 'event', 'operation', 'alarm', 'managedObject']
    const remaining = [...this.#created].sort(
      (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
    )
    for (const { kind, id } of remaining) {
      const path = DELETE_PATH[kind]?.(id)
      if (!path)
        continue // not individually deletable; removed with its device
      try {
        await this.#req('DELETE', path)
      } catch {
        failed.push(`${kind}:${id}`)
      }
    }
    this.#created.length = 0
    return failed
  }
}
