import { describe, expect, it } from 'vitest'
import { createRealtimeClient, isValidRealtimeName, REALTIME_NAME_REGEX, toRealtimeName } from '../../src/realtime'
import { delay, MockSocket, waitFor } from './mock-socket'
import type { Alarm, DeletionPayload } from '../../src/domain'
import type { RealtimeClientOptions } from '../../src/realtime'
import type { WebSocketFactory } from '../../src/types'

/**
 * Fake fetch answering ensure (POST subscriptions) and token minting. The
 * minted token embeds the subscription (topic) name so a mock socket's URL
 * reveals which type-topic it belongs to.
 */
function fakeFetch(): typeof fetch {
  return (async (url: string, init?: { method?: string, body?: string }) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) as { subscription?: string } : {}
    if (url.includes('notification2/token'))
      return json({ token: `tok-${body.subscription}` })
    if (url.includes('notification2/subscriptions') && method === 'POST')
      return json({ id: `sub-${body.subscription}`, ...body }, 201)
    return json({ subscriptions: [] })
  }) as unknown as typeof fetch
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function makeRealtime(overrides: Partial<RealtimeClientOptions> = {}) {
  return createRealtimeClient({
    name: 'c8yRealtime',
    baseUrl: 'https://a.com',
    tenant: 't',
    user: 'u',
    password: 'p',
    webSocketImpl: MockSocket as unknown as WebSocketFactory,
    fetchImpl: fakeFetch(),
    resilience: { pingIntervalMs: 10_000, pongTimeoutMs: 10_000, initialBackoffMs: 5, maxBackoffMs: 20 },
    ...overrides,
  })
}

function frame(type: string, action: string, source: string, payload: object): string {
  return [`ACK-${type}-${action}-${source}`, `/t1/${type}/${source}`, action, '', JSON.stringify(payload)].join('\n')
}

/**
 * Wait for the consumer socket of a given topic (by name) and open it.
 * @param topicName
 */
async function socketFor(topicName: string): Promise<MockSocket> {
  await waitFor(() => MockSocket.instances.some((s) => s.url.includes(`tok-${topicName}`)), 2000)
  const socket = MockSocket.instances.find((s) => s.url.includes(`tok-${topicName}`))!
  socket.emit('open')
  return socket
}

describe('realtimeClient — construction', () => {
  it('requires a unique alphanumeric name', () => {
    const base = { baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'p' } as const
    // @ts-expect-error name is required
    expect(() => createRealtimeClient({ ...base })).toThrow(/name/)
    expect(() => createRealtimeClient({ ...base, name: '' })).toThrow(/name/)
    expect(() => createRealtimeClient({ ...base, name: 'has-hyphen' })).toThrow(/alphanumeric/)
    expect(() => createRealtimeClient({ ...base, name: 'myApp1' })).not.toThrow()
  })
})

describe('toRealtimeName', () => {
  it('leaves an already-valid alphanumeric name unchanged', () => {
    expect(toRealtimeName('myApp1')).toBe('myApp1')
  })

  it('strips separators (hyphens, dots, underscores, tildes)', () => {
    const sanitized = toRealtimeName('my-app.name_v2~beta')
    expect(sanitized).toBe('myappnamev2beta')
    expect(REALTIME_NAME_REGEX.test(sanitized)).toBe(true)
  })

  it('returns an empty string for all-separator input', () => {
    const sanitized = toRealtimeName('---...___')
    expect(sanitized).toBe('')
    // an empty result does not satisfy the rule — the caller must handle it
    expect(REALTIME_NAME_REGEX.test(sanitized)).toBe(false)
  })

  it('produces a name the constructor accepts', () => {
    const base = { baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'p' } as const
    const name = toRealtimeName('c8y/nitro-tenant.42')
    expect(() => createRealtimeClient({ ...base, name })).not.toThrow()
  })
})

describe('isValidRealtimeName', () => {
  it('accepts a valid lowercase name', () => {
    expect(isValidRealtimeName('myapp1')).toBe(true)
  })

  it('accepts uppercase and mixed-case names (the spec allows A-Z)', () => {
    expect(isValidRealtimeName('MYAPP')).toBe(true)
    expect(isValidRealtimeName('MyApp1')).toBe(true)
  })

  it('accepts an alphanumeric mix', () => {
    expect(isValidRealtimeName('c8yRealtime42')).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isValidRealtimeName('')).toBe(false)
  })

  it('rejects names containing separators (hyphen, dot, underscore, tilde)', () => {
    expect(isValidRealtimeName('has-hyphen')).toBe(false)
    expect(isValidRealtimeName('has.dot')).toBe(false)
    expect(isValidRealtimeName('has_underscore')).toBe(false)
    expect(isValidRealtimeName('has~tilde')).toBe(false)
  })

  it('rejects a whitespace string', () => {
    expect(isValidRealtimeName('   ')).toBe(false)
  })
})

describe('realtimeClient — one topic + consumer per type', () => {
  it('routes typed CREATE notifications to the matching namespace', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    const received: Alarm[] = []
    rt.alarms.onCreate('*', (alarm) => {
      received.push(alarm)
    })
    const socket = await socketFor('c8yRealtimeAlarms')
    socket.emit('message', frame('alarms', 'CREATE', '111', { id: 'a1', severity: 'MAJOR', source: { id: '111' } }))
    await waitFor(() => received.length >= 1)
    expect(received[0]?.id).toBe('a1')
    expect(received[0]?.severity).toBe('MAJOR')
    await rt.close()
  })

  it('gives onDelete a deletion payload', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    const deletions: DeletionPayload[] = []
    rt.events.onDelete('*', (payload) => {
      deletions.push(payload)
    })
    const socket = await socketFor('c8yRealtimeEvents')
    socket.emit('message', frame('events', 'DELETE', '222', { id: 'e9' }))
    await waitFor(() => deletions.length >= 1)
    expect(deletions[0]?.id).toBe('e9')
    await rt.close()
  })

  it('shares one consumer across all scopes of a type (not one per device)', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    rt.alarms.onCreate('111', () => {})
    rt.alarms.onCreate('222', () => {})
    rt.alarms.onCreate('*', () => {}) // all-devices, same Alarms topic
    await socketFor('c8yRealtimeAlarms')
    await delay(30)
    // three alarm registrations across two devices + tenant → ONE alarms consumer
    expect(MockSocket.instances.length).toBe(1)
    await rt.close()
  })

  it('uses a separate consumer per distinct type', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    rt.alarms.onCreate('111', () => {})
    rt.events.onCreate('111', () => {})
    await socketFor('c8yRealtimeAlarms')
    await socketFor('c8yRealtimeEvents')
    await delay(30)
    expect(MockSocket.instances.length).toBe(2)
    await rt.close()
  })

  it('routes by source id: all-devices handler fires for any, scoped only for its device', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    const all: string[] = []
    const scoped: string[] = []
    rt.alarms.onCreate('*', (a) => {
      all.push(String(a.id))
    })
    rt.alarms.onCreate('111', (a) => {
      scoped.push(String(a.id))
    })
    const socket = await socketFor('c8yRealtimeAlarms')
    socket.emit('message', frame('alarms', 'CREATE', '111', { id: 'aDev' }))
    socket.emit('message', frame('alarms', 'CREATE', '999', { id: 'aOther' }))
    await waitFor(() => all.length >= 2)
    expect(all).toEqual(['aDev', 'aOther'])
    expect(scoped).toEqual(['aDev'])
    await rt.close()
  })
})

describe('realtimeClient — subscriptions are single-type, forward everything', () => {
  function capturingClient() {
    const posted: Array<{ subscription?: string, context?: string, source?: { id?: string }, subscriptionFilter?: { apis?: string[], typeFilter?: string }, fragmentsToCopy?: string[] }> = []
    const fetchImpl = (async (url: string, init?: { method?: string, body?: string }) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (url.includes('notification2/token'))
        return json({ token: `tok-${(body as { subscription?: string }).subscription}` })
      if (url.includes('notification2/subscriptions') && method === 'POST') {
        posted.push(body)
        return json({ id: `sub-${posted.length}`, ...body }, 201)
      }
      return json({ subscriptions: [] })
    }) as unknown as typeof fetch
    const rt = createRealtimeClient({
      name: 'c8yRealtime',
      baseUrl: 'https://a.com',
      tenant: 't',
      user: 'u',
      password: 'p',
      webSocketImpl: MockSocket as unknown as WebSocketFactory,
      fetchImpl,
    })
    return { rt, posted }
  }

  it('creates one single-type subscription per (type, scope) with apis [type]', async () => {
    MockSocket.reset()
    const { rt, posted } = capturingClient()
    rt.alarms.onCreate('2468', () => {})
    rt.events.onCreate('2468', () => {})
    await rt.start()
    // Two separate subs — NOT one merged ['alarms','events'] sub.
    const alarms = posted.find((p) => p.subscription === 'c8yRealtimeAlarms')
    const events = posted.find((p) => p.subscription === 'c8yRealtimeEvents')
    expect(alarms?.subscriptionFilter?.apis).toEqual(['alarms'])
    expect(alarms?.source?.id).toBe('2468')
    expect(events?.subscriptionFilter?.apis).toEqual(['events'])
    expect(events?.source?.id).toBe('2468')
    await rt.close()
  })

  it('uses a tenant sub for all-devices and mo subs for device scopes', async () => {
    MockSocket.reset()
    const { rt, posted } = capturingClient()
    rt.alarms.onCreate('*', () => {}) // tenant
    rt.measurements.onCreate('145075', () => {}) // mo
    await rt.start()
    const alarms = posted.find((p) => p.subscription === 'c8yRealtimeAlarms')
    const meas = posted.find((p) => p.subscription === 'c8yRealtimeMeasurements')
    expect(alarms?.context).toBe('tenant')
    expect(meas?.context).toBe('mo')
    expect(meas?.source?.id).toBe('145075')
    expect(meas?.subscriptionFilter?.apis).toEqual(['measurements'])
    await rt.close()
  })

  it('uses apis ["*"] and the All topic for onAny', async () => {
    MockSocket.reset()
    const { rt, posted } = capturingClient()
    rt.onAny(() => {})
    await rt.start()
    const all = posted.find((p) => p.subscription === 'c8yRealtimeAll')
    expect(all?.subscriptionFilter?.apis).toEqual(['*'])
    await rt.close()
  })

  it('never sends a typeFilter or fragmentsToCopy — subscriptions forward the full message', async () => {
    MockSocket.reset()
    const { rt, posted } = capturingClient()
    rt.measurements.onCreate('2468', () => {})
    rt.alarms.onCreate('*', () => {})
    rt.onAny(() => {})
    await rt.start()
    expect(posted.length).toBeGreaterThan(0)
    for (const sub of posted) {
      expect(sub.subscriptionFilter?.typeFilter).toBeUndefined()
      expect(sub.fragmentsToCopy).toBeUndefined()
    }
    await rt.close()
  })

  it('two handlers on the same (type, device) share one subscription — no conflict', async () => {
    MockSocket.reset()
    const { rt, posted } = capturingClient()
    rt.measurements.onCreate('2468', () => {})
    rt.measurements.onCreate('2468', () => {}) // same (type, scope), second handler
    await rt.start()
    const meas = posted.filter((p) => p.subscription === 'c8yRealtimeMeasurements' && p.source?.id === '2468')
    expect(meas.length).toBe(1) // only one subscription created for the pair
    await rt.close()
  })

  it('delivers the full payload to every handler on a shared (type, device)', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    rt.measurements.onCreate('111', (m) => {
      seenA.push((m as Record<string, unknown>).c8y_Speed)
    })
    rt.measurements.onCreate('111', (m) => {
      seenB.push((m as Record<string, unknown>).c8y_Temperature)
    })
    const socket = await socketFor('c8yRealtimeMeasurements')
    socket.emit('message', frame('measurements', 'CREATE', '111', { id: 'm1', source: { id: '111' }, c8y_Speed: 5, c8y_Temperature: 20 }))
    await waitFor(() => seenA.length >= 1 && seenB.length >= 1)
    // Both handlers see all fragments — nothing was filtered/stripped upstream.
    expect(seenA).toEqual([5])
    expect(seenB).toEqual([20])
    await rt.close()
  })
})

describe('realtimeClient — hookable-style keys', () => {
  it('routes via "type:action:*" keys', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    const hits: string[] = []
    rt.hook('operations:update:*', (op) => {
      hits.push(String(op.status))
    })
    const socket = await socketFor('c8yRealtimeOperations')
    socket.emit('message', frame('operations', 'UPDATE', '333', { id: 'o1', deviceId: '333', status: 'EXECUTING' }))
    await waitFor(() => hits.length >= 1)
    expect(hits[0]).toBe('EXECUTING')
    await rt.close()
  })

  it('scopes to a source id embedded in the key', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    const scoped: string[] = []
    rt.hook('measurements:create:111', (m) => {
      scoped.push(String(m.id))
    })
    const socket = await socketFor('c8yRealtimeMeasurements')
    socket.emit('message', frame('measurements', 'CREATE', '111', { id: 'm1', source: { id: '111' } }))
    socket.emit('message', frame('measurements', 'CREATE', '222', { id: 'm2', source: { id: '222' } }))
    await waitFor(() => scoped.length >= 1)
    await delay(20)
    expect(scoped).toEqual(['m1'])
    await rt.close()
  })
})

describe('realtimeClient — unsubscribe by key & inspection', () => {
  it('lists registered hook keys in the canonical :* form', () => {
    MockSocket.reset()
    const rt = makeRealtime({ autoStart: false })
    rt.alarms.onCreate('*', () => {}) // → 'alarms:create:*'
    rt.alarms.onCreate('145075', () => {}) // → 'alarms:create:145075'
    rt.events.onUpdate('*', () => {}) // → 'events:update:*'
    expect(new Set(rt.hookKeys())).toEqual(
      new Set(['alarms:create:*', 'alarms:create:145075', 'events:update:*']),
    )
  })

  it('exposes managedobjects:create as the all-devices :* key', () => {
    MockSocket.reset()
    const rt = makeRealtime({ autoStart: false })
    rt.managedObjects.onCreate('*', () => {})
    expect(rt.hookKeys()).toEqual(['managedobjects:create:*'])
    expect(rt.hasHook('managedobjects:create:*')).toBe(true)
  })

  it('keys the all-devices onAny firehose as "*", excluding scoped firehoses', () => {
    MockSocket.reset()
    const rt = makeRealtime({ autoStart: false })
    rt.onAny(() => {}) // global firehose → internal '*#*:*' → key '*'
    rt.onAny('145075', () => {}) // scoped firehose → internal '145075#*:*' → no key
    rt.alarms.onAny('*', () => {}) // per-type firehose → internal '*#alarms:*' → no key
    rt.alarms.onCreate('*', () => {}) // a concrete keyed hook
    expect(rt.hookKeys()).toEqual(['*', 'alarms:create:*'])
    expect(rt.hasHook('*')).toBe(true)
  })

  it('unsubscribe("*") removes the all-devices onAny firehose', () => {
    MockSocket.reset()
    const rt = makeRealtime({ autoStart: false })
    rt.onAny(() => {})
    rt.onAny(() => {})
    expect(rt.hasHook('*')).toBe(true)
    const result = rt.unsubscribe('*')
    expect(result.removed).toBe(true)
    expect(result.count).toBe(2)
    expect(rt.hasHook('*')).toBe(false)
    expect(rt.hookKeys()).toEqual([])
  })

  it('every hookKeys() entry round-trips through hasHook/unsubscribe (single :* spelling)', () => {
    MockSocket.reset()
    const rt = makeRealtime({ autoStart: false })
    rt.hook('events:update:*', () => {})
    expect(rt.hookKeys()).toEqual(['events:update:*'])
    // One canonical spelling → .includes() and hasHook agree.
    expect(rt.hookKeys().includes('events:update:*')).toBe(true)
    expect(rt.hasHook('events:update:*')).toBe(true)
    // A second registration under the same key funnels together…
    rt.hook('events:update:*', () => {})
    expect(rt.hookKeys()).toEqual(['events:update:*']) // still one key
    expect(rt.unsubscribe('events:update:*')).toEqual({ removed: true, count: 2, subscriptionDeleted: true })
    expect(rt.hasHook('events:update:*')).toBe(false)
  })

  it('unsubscribe removes every handler for a key and reports the count', () => {
    MockSocket.reset()
    const rt = makeRealtime({ autoStart: false })
    rt.alarms.onCreate('145075', () => {})
    rt.hook('alarms:create:145075', () => {}) // same (type, scope)
    expect(rt.hasHook('alarms:create:145075')).toBe(true)
    const result = rt.unsubscribe('alarms:create:145075')
    expect(result).toEqual({ removed: true, count: 2, subscriptionDeleted: true })
    expect(rt.hasHook('alarms:create:145075')).toBe(false)
    expect(rt.hookKeys()).not.toContain('alarms:create:145075')
  })

  it('unsubscribe on an unregistered key reports removed:false, count:0', () => {
    MockSocket.reset()
    const rt = makeRealtime({ autoStart: false })
    expect(rt.unsubscribe('events:update:*')).toEqual({ removed: false, count: 0, subscriptionDeleted: false })
  })

  it('a key-based unsubscribe stops delivery to those handlers', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    const hits: string[] = []
    rt.alarms.onCreate('111', (a) => {
      hits.push(String(a.id))
    })
    const socket = await socketFor('c8yRealtimeAlarms')
    socket.emit('message', frame('alarms', 'CREATE', '111', { id: 'before' }))
    await waitFor(() => hits.length >= 1)
    expect(rt.unsubscribe('alarms:create:111')).toEqual({ removed: true, count: 1, subscriptionDeleted: true })
    socket.emit('message', frame('alarms', 'CREATE', '111', { id: 'after' }))
    await delay(20)
    expect(hits).toEqual(['before']) // 'after' not delivered
    await rt.close()
  })

  it('a returned Unsubscribe closure is idempotent after unsubscribe(key)', () => {
    MockSocket.reset()
    const rt = makeRealtime({ autoStart: false })
    const off = rt.alarms.onCreate('111', () => {})
    expect(rt.unsubscribe('alarms:create:111')).toEqual({ removed: true, count: 1, subscriptionDeleted: true })
    // The closure for an already-removed handler is a harmless no-op.
    expect(() => off()).not.toThrow()
    expect(rt.hasHook('alarms:create:111')).toBe(false)
  })

  it('unsubscribe leaves other keys and scopes untouched', () => {
    MockSocket.reset()
    const rt = makeRealtime({ autoStart: false })
    rt.alarms.onCreate('*', () => {}) // all-devices
    rt.alarms.onCreate('111', () => {}) // device
    rt.unsubscribe('alarms:create:111')
    expect(rt.hasHook('alarms:create:*')).toBe(true) // all-devices survives
    expect(rt.hasHook('alarms:create:111')).toBe(false)
  })
})

describe('realtimeClient — onAny firehose & dedupe', () => {
  it('onAny receives every notification on the All topic', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    let count = 0
    rt.onAny(() => {
      count += 1
    })
    const socket = await socketFor('c8yRealtimeAll')
    socket.emit('message', frame('alarms', 'CREATE', '1', { id: 'a' }))
    socket.emit('message', frame('events', 'UPDATE', '1', { id: 'e' }))
    socket.emit('message', frame('managedobjects', 'DELETE', '1', { id: 'm' }))
    await waitFor(() => count >= 3)
    expect(count).toBe(3)
    await rt.close()
  })

  it('onAny can scope to a single device feed', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    const seen: string[] = []
    rt.onAny('111', (_p, n) => {
      seen.push(n.description.sourceId ?? '')
    })
    const socket = await socketFor('c8yRealtimeAll')
    socket.emit('message', frame('alarms', 'CREATE', '111', { id: 'a1' }))
    socket.emit('message', frame('alarms', 'CREATE', '999', { id: 'a2' }))
    await waitFor(() => seen.length >= 1)
    await delay(20)
    expect(seen).toEqual(['111'])
    await rt.close()
  })

  it('a type consumer fires only its own handlers, not onAny', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    let alarms = 0
    let any = 0
    rt.alarms.onCreate('*', () => {
      alarms += 1
    })
    rt.onAny(() => {
      any += 1
    })
    const alarmsSocket = await socketFor('c8yRealtimeAlarms')
    await socketFor('c8yRealtimeAll')
    // An alarm delivered on the Alarms topic fires alarms handlers only.
    alarmsSocket.emit('message', frame('alarms', 'CREATE', '1', { id: 'a1' }))
    await waitFor(() => alarms >= 1)
    await delay(20)
    expect(alarms).toBe(1)
    expect(any).toBe(0) // onAny is driven by the All topic, not the Alarms topic
    await rt.close()
  })

  it('suppresses duplicate (identical) notifications per topic', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    let count = 0
    rt.onAny(() => {
      count += 1
    })
    const socket = await socketFor('c8yRealtimeAll')
    const dup = frame('alarms', 'CREATE', '1', { id: 'a1', text: 'same' })
    socket.emit('message', dup)
    socket.emit('message', dup)
    await waitFor(() => count >= 1)
    await delay(20)
    expect(count).toBe(1)
    await rt.close()
  })

  it('does NOT suppress genuinely distinct updates of the same entity', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    let count = 0
    rt.onAny(() => {
      count += 1
    })
    const socket = await socketFor('c8yRealtimeAll')
    socket.emit('message', frame('alarms', 'UPDATE', '1', { id: 'a1', status: 'ACTIVE' }))
    socket.emit('message', frame('alarms', 'UPDATE', '1', { id: 'a1', status: 'CLEARED' }))
    await waitFor(() => count >= 2)
    expect(count).toBe(2)
    await rt.close()
  })
})

describe('realtimeClient — subscription lifecycle & labels', () => {
  function lifecycleClient(overrides: Partial<RealtimeClientOptions> = {}) {
    const posted: string[] = []
    const deleted: string[] = []
    const fetchImpl = (async (url: string, init?: { method?: string, body?: string }) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) as { subscription?: string } : {}
      if (url.includes('notification2/token'))
        return json({ token: `tok-${body.subscription}` })
      if (url.includes('notification2/subscriptions') && method === 'POST') {
        posted.push(body.subscription ?? '')
        return json({ id: `sub-${posted.length}`, ...body }, 201)
      }
      if (url.includes('notification2/subscriptions/') && method === 'DELETE') {
        deleted.push(url.split('/').pop()!.split('?')[0]!)
        return new Response(null, { status: 204 })
      }
      return json({ subscriptions: [] })
    }) as unknown as typeof fetch
    const rt = createRealtimeClient({
      name: 'c8yRealtime',
      baseUrl: 'https://a.com',
      tenant: 't',
      user: 'u',
      password: 'p',
      webSocketImpl: MockSocket as unknown as WebSocketFactory,
      fetchImpl,
      autoStart: false,
      ...overrides,
    })
    return { rt, posted, deleted }
  }

  it('deletes the remote subscription when the last handler is removed (default on)', async () => {
    MockSocket.reset()
    const { rt, deleted } = lifecycleClient()
    const off = rt.alarms.onCreate('111', () => {})
    await rt.start()
    off()
    await delay(10)
    expect(deleted).toEqual(['sub-1'])
    await rt.close()
  })

  it('keeps the remote subscription on removal when deleteSubscriptionOnEmpty is false', async () => {
    MockSocket.reset()
    const { rt, deleted } = lifecycleClient({ deleteSubscriptionOnEmpty: false })
    const off = rt.alarms.onCreate('111', () => {})
    await rt.start()
    off()
    await delay(10)
    expect(deleted).toEqual([])
    await rt.close()
  })

  it('unsubscribe(key) always deletes the remote, even with deleteSubscriptionOnEmpty false', async () => {
    MockSocket.reset()
    const { rt, deleted } = lifecycleClient({ deleteSubscriptionOnEmpty: false })
    rt.alarms.onCreate('111', () => {})
    await rt.start()
    expect(rt.unsubscribe('alarms:create:111')).toEqual({ removed: true, count: 1, subscriptionDeleted: true })
    await delay(10)
    expect(deleted).toEqual(['sub-1'])
    await rt.close()
  })

  it('detach(key) removes handlers but keeps the remote subscription', async () => {
    MockSocket.reset()
    const { rt, deleted } = lifecycleClient() // default delete-on-empty on
    rt.alarms.onCreate('111', () => {})
    await rt.start()
    expect(rt.detach('alarms:create:111')).toEqual({ removed: true, count: 1, subscriptionDeleted: false })
    await delay(10)
    expect(deleted).toEqual([]) // kept despite the config being on
    expect(rt.hasHook('alarms:create:111')).toBe(false)
    await rt.close()
  })

  it('does not delete the shared (type,scope) sub while another action still has a handler', async () => {
    MockSocket.reset()
    const { rt, posted, deleted } = lifecycleClient()
    rt.alarms.onCreate('111', () => {})
    rt.alarms.onUpdate('111', () => {})
    await rt.start()
    expect(posted.filter((s) => s === 'c8yRealtimeAlarms').length).toBe(1) // one shared sub
    expect(rt.unsubscribe('alarms:create:111').subscriptionDeleted).toBe(false) // update still needs it
    await delay(10)
    expect(deleted).toEqual([])
    expect(rt.unsubscribe('alarms:update:111').subscriptionDeleted).toBe(true) // now empty
    await delay(10)
    expect(deleted).toEqual(['sub-1'])
    await rt.close()
  })

  it('a re-subscribe waits for an in-flight delete before recreating (no lost subscription)', async () => {
    MockSocket.reset()
    const events: string[] = []
    let releaseDelete: (() => void) | undefined
    const fetchImpl = (async (url: string, init?: { method?: string, body?: string }) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) as { subscription?: string } : {}
      if (url.includes('notification2/token'))
        return json({ token: `tok-${body.subscription}` })
      if (url.includes('notification2/subscriptions') && method === 'POST') {
        events.push('create')
        return json({ id: `sub-${body.subscription}`, ...body }, 201)
      }
      if (url.includes('notification2/subscriptions/') && method === 'DELETE') {
        events.push('delete-start')
        await new Promise<void>((resolve) => {
          releaseDelete = resolve
        }) // gate the delete open
        events.push('delete-end')
        return new Response(null, { status: 204 })
      }
      return json({ subscriptions: [] })
    }) as unknown as typeof fetch
    const rt = createRealtimeClient({
      name: 'c8yRealtime',
      baseUrl: 'https://a.com',
      tenant: 't',
      user: 'u',
      password: 'p',
      webSocketImpl: MockSocket as unknown as WebSocketFactory,
      fetchImpl,
      autoStart: false,
    })

    const off = rt.alarms.onCreate('111', () => {}) // first create
    await rt.start()
    off() // last handler gone → starts the (gated) delete
    await waitFor(() => events.includes('delete-start'))

    rt.alarms.onCreate('111', () => {}) // re-subscribe while the delete is still in flight
    await delay(10)
    expect(events).toEqual(['create', 'delete-start']) // recreate is holding, not racing

    releaseDelete!() // let the delete finish
    await waitFor(() => events.filter((e) => e === 'create').length >= 2)
    // the recreate ran only after the delete completed — never interleaved
    expect(events).toEqual(['create', 'delete-start', 'delete-end', 'create'])
    await rt.close()
  })

  it('removes a single handler by unique label; reports found + subscriptionDeleted', () => {
    MockSocket.reset()
    const { rt } = lifecycleClient()
    rt.alarms.onCreate('111', () => {}, 'featureA')
    rt.alarms.onCreate('111', () => {}, 'featureB') // same (type,scope), 2 handlers
    // featureA is not the last for alarms#111 → subscription kept
    expect(rt.unhook('featureA')).toEqual({ removed: true, subscriptionDeleted: false })
    expect(rt.hasHook('alarms:create:111')).toBe(true)
    // unknown / already-removed labels report removed:false
    expect(rt.unhook('featureA')).toEqual({ removed: false, subscriptionDeleted: false })
    expect(rt.unhook('nope')).toEqual({ removed: false, subscriptionDeleted: false })
    // featureB is the last → subscription torn down
    expect(rt.unhook('featureB')).toEqual({ removed: true, subscriptionDeleted: true })
    expect(rt.hasHook('alarms:create:111')).toBe(false)
  })

  it('throws on a duplicate label while it is still registered; frees it on removal', () => {
    MockSocket.reset()
    const { rt } = lifecycleClient()
    const off = rt.alarms.onCreate('111', () => {}, 'dup')
    expect(() => rt.alarms.onCreate('222', () => {}, 'dup')).toThrow(/label/)
    off() // frees the label
    expect(() => rt.alarms.onCreate('222', () => {}, 'dup')).not.toThrow()
  })
})

describe('realtimeClient — acknowledgement', () => {
  it('auto-acks after handlers resolve by default', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    rt.alarms.onCreate('*', async () => {
      await delay(5)
    })
    const socket = await socketFor('c8yRealtimeAlarms')
    socket.emit('message', frame('alarms', 'CREATE', '1', { id: 'a1' }))
    await waitFor(() => socket.sent.length >= 1)
    expect(socket.sent[0]).toBe('ACK-alarms-CREATE-1')
    await rt.close()
  })

  it('does not auto-ack when autoAck is false', async () => {
    MockSocket.reset()
    const rt = makeRealtime({ autoAck: false })
    let acked = false
    rt.alarms.onCreate('*', () => {
      acked = true
    })
    const socket = await socketFor('c8yRealtimeAlarms')
    socket.emit('message', frame('alarms', 'CREATE', '1', { id: 'a1' }))
    await waitFor(() => acked)
    await delay(20)
    expect(socket.sent).toEqual([])
    await rt.close()
  })
})
