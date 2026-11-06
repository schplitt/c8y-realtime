import { describe, expect, expectTypeOf, it } from 'vitest'
import { createRealtimeClient, isValidRealtimeName, REALTIME_NAME_REGEX, toRealtimeName } from '../../src/realtime'
import { delay, MockSocket, waitFor } from './mock-socket'
import type { Alarm, DeletionPayload } from '../../src/domain'
import type { RealtimeClientOptions, TypeHooks } from '../../src/realtime'
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

  it('unfiltered registrations never send a typeFilter or fragmentsToCopy — they forward the full message', async () => {
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

  it('removes a single handler by unique label; reports removed + subscriptionDeleted', () => {
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
    let handled = false
    rt.alarms.onCreate('*', () => {
      handled = true
    })
    const socket = await socketFor('c8yRealtimeAlarms')
    socket.emit('message', frame('alarms', 'CREATE', '1', { id: 'a1' }))
    await waitFor(() => handled)
    await delay(20)
    expect(socket.sent).toEqual([])
    await rt.close()
  })
})

describe('realtimeClient — updateCredentials (repair after creds run out)', () => {
  /**
   * A fetch that records the `Authorization` header seen on token mints and on
   * subscription list calls, and can be switched to fail either endpoint. The
   * minted token embeds the topic name (so `socketFor` can find its socket).
   */
  function credFetch() {
    const state = {
      tokenAuth: [] as string[],
      listAuth: [] as string[],
      failTokenStatus: 0,
      failListStatus: 0,
    }
    const fetchImpl = (async (url: string, init?: { method?: string, body?: string, headers?: Record<string, string> }) => {
      const method = init?.method ?? 'GET'
      const auth = init?.headers?.Authorization ?? ''
      const body = init?.body ? JSON.parse(init.body) as { subscription?: string } : {}
      if (url.includes('notification2/token')) {
        state.tokenAuth.push(auth)
        return state.failTokenStatus ? json({ error: 'unauthorized' }, state.failTokenStatus) : json({ token: `tok-${body.subscription}` })
      }
      if (url.includes('notification2/subscriptions') && method === 'POST')
        return json({ id: `sub-${body.subscription}`, ...body }, 201)
      // GET notification2/subscriptions — the updateCredentials auth probe.
      state.listAuth.push(auth)
      return state.failListStatus ? json({ error: 'unauthorized' }, state.failListStatus) : json({ subscriptions: [] })
    }) as unknown as typeof fetch
    return { fetchImpl, state }
  }

  function makeCredRealtime(fetchImpl: typeof fetch) {
    return createRealtimeClient({
      name: 'c8yRealtime',
      baseUrl: 'https://a.com',
      tenant: 't',
      user: 'u',
      password: 'p',
      webSocketImpl: MockSocket as unknown as WebSocketFactory,
      fetchImpl,
      resilience: { pingIntervalMs: 10_000, pongTimeoutMs: 10_000, initialBackoffMs: 5, maxBackoffMs: 20 },
    })
  }

  it('rejects updating a healthy client and changes nothing', async () => {
    MockSocket.reset()
    const { fetchImpl, state } = credFetch()
    const rt = makeCredRealtime(fetchImpl)
    rt.alarms.onCreate('*', () => {})
    const socket = await socketFor('c8yRealtimeAlarms')
    await waitFor(() => state.tokenAuth.length >= 1)
    const oldAuth = state.tokenAuth[0]
    expect(rt.healthy).toBe(true)

    await expect(
      rt.updateCredentials({ baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'p2' }),
    ).rejects.toThrow(/healthy/)

    // Nothing was disturbed: no validation probe ran, the socket stayed up, and
    // the credentials were never swapped.
    expect(state.listAuth.length).toBe(0)
    expect(MockSocket.instances.length).toBe(1)
    expect(socket.closedWith).toBeUndefined()
    socket.emit('close')
    await waitFor(() => MockSocket.instances.length >= 2)
    expect(state.tokenAuth.at(-1)).toBe(oldAuth) // the reconnect still uses the old creds
    await rt.close()
  })

  it('restarts a consumer that had fatally stopped, using the new creds, keeping its handler', async () => {
    MockSocket.reset()
    const { fetchImpl, state } = credFetch()
    state.failTokenStatus = 401 // creds ran out → first mint fails → consumer stops
    const rt = makeCredRealtime(fetchImpl)
    const received: string[] = []
    rt.alarms.onCreate('*', (a) => {
      received.push(String(a.id))
    })
    // The consumer attempts one mint, gets 401 (fatal), stops → client unhealthy.
    await waitFor(() => !rt.healthy)
    expect(MockSocket.instances.length).toBe(0)

    // Fresh creds arrive.
    state.failTokenStatus = 0
    await rt.updateCredentials({ baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'p2' })
    expect(rt.healthy).toBe(true)

    // The stopped consumer is restarted and connects; the original handler fires.
    const socket = await socketFor('c8yRealtimeAlarms')
    socket.emit('message', frame('alarms', 'CREATE', '111', { id: 'aResumed' }))
    await waitFor(() => received.length >= 1)
    expect(received).toEqual(['aResumed'])
    await rt.close()
  })

  it('rejects bad new creds on an unhealthy client, keeps the old ones, and can retry', async () => {
    MockSocket.reset()
    const { fetchImpl, state } = credFetch()
    state.failTokenStatus = 401
    const rt = makeCredRealtime(fetchImpl)
    const received: string[] = []
    rt.alarms.onCreate('*', (a) => {
      received.push(String(a.id))
    })
    await waitFor(() => !rt.healthy)

    // The replacement creds are also bad → validation fails → reject, restart nothing.
    state.failListStatus = 401
    await expect(
      rt.updateCredentials({ baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'bad' }),
    ).rejects.toThrow()
    expect(rt.healthy).toBe(false) // still unhealthy; the once-valid creds are retained
    expect(MockSocket.instances.length).toBe(0)

    // Retry with working creds → repairs.
    state.failListStatus = 0
    state.failTokenStatus = 0
    await rt.updateCredentials({ baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'good' })
    const socket = await socketFor('c8yRealtimeAlarms')
    socket.emit('message', frame('alarms', 'CREATE', '111', { id: 'aResumed' }))
    await waitFor(() => received.length >= 1)
    expect(received).toEqual(['aResumed'])
    await rt.close()
  })

  it('does not resurrect a topic whose last handler was removed after it stopped', async () => {
    MockSocket.reset()
    const { fetchImpl, state } = credFetch()
    state.failTokenStatus = 401
    const rt = makeCredRealtime(fetchImpl)
    const off = rt.alarms.onCreate('*', () => {})
    await waitFor(() => !rt.healthy)

    // Caller gives up on this topic: removing its last handler clears the stopped
    // state, so the client is healthy again and there is nothing to repair.
    off()
    expect(rt.healthy).toBe(true)

    state.failTokenStatus = 0
    await expect(
      rt.updateCredentials({ baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'p2' }),
    ).rejects.toThrow(/healthy/)
    await delay(20)
    expect(MockSocket.instances.length).toBe(0)
    await rt.close()
  })
})

describe('realtimeClient — type filters (one topic per filter group)', () => {
  function filterClient(overrides: Partial<RealtimeClientOptions> = {}) {
    const posted: Array<{ id: string, subscription: string, context?: string, source?: { id?: string }, subscriptionFilter?: { apis?: string[], typeFilter?: string } }> = []
    const deleted: string[] = []
    const fetchImpl = (async (url: string, init?: { method?: string, body?: string }) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (url.includes('notification2/token'))
        return json({ token: `tok-${(body as { subscription?: string }).subscription}` })
      if (url.includes('notification2/subscriptions') && method === 'POST') {
        const id = `sub-${posted.length + 1}`
        posted.push({ id, ...(body as { subscription: string }) })
        return json({ id, ...body }, 201)
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
      resilience: { pingIntervalMs: 10_000, pongTimeoutMs: 10_000, initialBackoffMs: 5, maxBackoffMs: 20 },
      ...overrides,
    })
    return { rt, posted, deleted }
  }

  const FILTERED_TOPIC = /^c8yRealtimeAlarmsF[a-z0-9]{1,13}$/

  it('creates a filtered single-type subscription on its own F<hash> topic with the OData typeFilter', async () => {
    MockSocket.reset()
    const { rt, posted } = filterClient({ autoStart: false })
    rt.alarms.onCreate({ source: '*', type: ['c8y_B', 'c8y_A'] }, () => {})
    await rt.start()
    expect(posted).toHaveLength(1)
    const sub = posted[0]!
    expect(sub.subscription).toMatch(FILTERED_TOPIC)
    expect(sub.context).toBe('tenant')
    expect(sub.subscriptionFilter?.apis).toEqual(['alarms'])
    expect(sub.subscriptionFilter?.typeFilter).toBe('\'c8y_A\' or \'c8y_B\'')
    await rt.close()
  })

  it('the topic name is a stable function of the type set (a hash change would silently create new topics)', async () => {
    MockSocket.reset()
    const { rt, posted } = filterClient({ autoStart: false })
    rt.alarms.onCreate({ source: '*', type: ['c8y_A', 'c8y_B'] }, () => {})
    await rt.start()
    // FNV-1a 64 of "c8y_A|c8y_B", base36. Pinned on purpose: existing deployments
    // reuse this name across runs, so it must never drift.
    expect(posted[0]!.subscription).toBe('c8yRealtimeAlarmsFfqww3fy4jkgq')
    await rt.close()
  })

  it('a filtered per-type onAny and a filtered device scope route on the group topic; detach keeps the group', async () => {
    MockSocket.reset()
    const { rt, posted, deleted } = filterClient()
    const seen: string[] = []
    rt.alarms.onAny({ source: '7', type: 'c8y_A' }, (p, n) => {
      seen.push(`${n.action}:${String((p as { id: string }).id)}`)
    })
    await rt.start()
    expect(posted[0]!.context).toBe('mo')
    expect(posted[0]!.subscriptionFilter?.typeFilter).toBe('\'c8y_A\'')
    const socket = await socketFor(posted[0]!.subscription)
    socket.emit('message', frame('alarms', 'CREATE', '7', { id: 'c', type: 'c8y_A', source: { id: '7' } }))
    socket.emit('message', frame('alarms', 'DELETE', '7', { id: 'd' }))
    await waitFor(() => seen.length >= 2)
    expect(seen).toEqual(['CREATE:c', 'DELETE:d'])
    // detach on a filtered key: handlers gone, remote kept
    rt.alarms.onCreate({ source: '7', type: 'c8y_A' }, () => {})
    expect(rt.detach('alarms:create:7:c8y_A')).toMatchObject({ removed: true, count: 1, subscriptionDeleted: false })
    await delay(10)
    expect(deleted).toEqual([])
    await rt.close()
  })

  it('a single type is sent quoted; an inner quote is doubled (OData escaping)', async () => {
    MockSocket.reset()
    const { rt, posted } = filterClient({ autoStart: false })
    rt.events.onCreate({ source: '12345', type: 'c8y_O\'Brien' }, () => {})
    await rt.start()
    expect(posted[0]?.context).toBe('mo')
    expect(posted[0]?.source?.id).toBe('12345')
    expect(posted[0]?.subscriptionFilter?.typeFilter).toBe('\'c8y_O\'\'Brien\'')
    await rt.close()
  })

  it('the same type set in any order / with duplicates maps to ONE topic and ONE subscription', async () => {
    MockSocket.reset()
    const { rt, posted } = filterClient({ autoStart: false })
    rt.alarms.onCreate({ source: '*', type: ['c8y_A', 'c8y_B'] }, () => {})
    rt.alarms.onCreate({ source: '*', type: ['c8y_B', 'c8y_A', 'c8y_B'] }, () => {})
    rt.alarms.onUpdate({ source: '*', type: 'c8y_A' }, () => {}) // different set → different topic
    await rt.start()
    expect(posted).toHaveLength(2)
    expect(posted[0]!.subscription).not.toBe(posted[1]!.subscription)
    expect(posted.every((p) => FILTERED_TOPIC.test(p.subscription))).toBe(true)
    await rt.close()
  })

  it('filtered and unfiltered on the same scope are separate topics; each frame fires only its own handlers, once', async () => {
    MockSocket.reset()
    const { rt, posted } = filterClient()
    const all: string[] = []
    const onlyA: string[] = []
    rt.alarms.onCreate('*', (a) => {
      all.push(a.id)
    })
    rt.alarms.onCreate({ source: '*', type: 'c8y_A' }, (a) => {
      onlyA.push(a.id)
    })
    await rt.start()
    const filteredName = posted.find((p) => p.subscriptionFilter?.typeFilter)!.subscription
    const plain = await socketFor('c8yRealtimeAlarms')
    const filtered = await socketFor(filteredName)
    expect(plain).not.toBe(filtered)
    plain.emit('message', frame('alarms', 'CREATE', '1', { id: 'p1', type: 'c8y_A', source: { id: '1' } }))
    filtered.emit('message', frame('alarms', 'CREATE', '1', { id: 'f1', type: 'c8y_A', source: { id: '1' } }))
    await waitFor(() => all.length >= 1 && onlyA.length >= 1)
    await delay(20)
    expect(all).toEqual(['p1'])
    expect(onlyA).toEqual(['f1'])
    await rt.close()
  })

  it('guards a filter-group topic: a frame whose type is outside the set is acked and dropped', async () => {
    MockSocket.reset()
    const { rt, posted } = filterClient()
    const seen: string[] = []
    rt.alarms.onCreate({ source: '*', type: 'c8y_A' }, (a) => {
      seen.push(a.type)
    })
    await rt.start()
    const socket = await socketFor(posted[0]!.subscription)
    socket.emit('message', frame('alarms', 'CREATE', '1', { id: 'x', type: 'c8y_Other', source: { id: '1' } }))
    socket.emit('message', frame('alarms', 'CREATE', '1', { id: 'y', type: 'c8y_A', source: { id: '1' } }))
    await waitFor(() => seen.length >= 1)
    expect(seen).toEqual(['c8y_A'])
    await waitFor(() => socket.sent.length >= 2)
    expect(socket.sent).toEqual(['ACK-alarms-CREATE-1', 'ACK-alarms-CREATE-1'])
    await rt.close()
  })

  it('a filtered onDelete shares the group topic and passes the type-less DELETE payload through the guard', async () => {
    MockSocket.reset()
    const { rt, posted } = filterClient()
    const deletes: string[] = []
    rt.alarms.onCreate({ source: '*', type: 'c8y_A' }, () => {})
    rt.alarms.onDelete({ source: '*', type: 'c8y_A' }, ({ id }) => {
      deletes.push(id)
    })
    await rt.start()
    expect(posted).toHaveLength(1) // same (group, scope) → one subscription
    expect(posted[0]!.subscriptionFilter?.typeFilter).toBe('\'c8y_A\'')
    const socket = await socketFor(posted[0]!.subscription)
    socket.emit('message', frame('alarms', 'DELETE', '1', { id: 'gone' }))
    await waitFor(() => deletes.length >= 1)
    expect(deletes).toEqual(['gone'])
    await rt.close()
  })

  it('the guard acks a dropped out-of-set frame even with autoAck off', async () => {
    MockSocket.reset()
    const { rt, posted } = filterClient({ autoAck: false })
    rt.alarms.onCreate({ source: '*', type: 'c8y_A' }, () => {})
    await rt.start()
    const socket = await socketFor(posted[0]!.subscription)
    socket.emit('message', frame('alarms', 'CREATE', '1', { id: 'x', type: 'c8y_Other', source: { id: '1' } }))
    await waitFor(() => socket.sent.length >= 1)
    expect(socket.sent).toEqual(['ACK-alarms-CREATE-1'])
    await rt.close()
  })

  it('the 4th-segment key form is the same registration as the object form', async () => {
    MockSocket.reset()
    const { rt, posted } = filterClient({ autoStart: false })
    const seen: string[] = []
    rt.hook('alarms:create:*:c8y_B|c8y_A', (a) => {
      seen.push(`key:${a.id}`)
    })
    rt.alarms.onCreate({ source: '*', type: ['c8y_A', 'c8y_B'] }, (a) => {
      seen.push(`obj:${a.id}`)
    })
    await rt.start()
    expect(posted).toHaveLength(1)
    expect(rt.hookKeys()).toEqual(['alarms:create:*:c8y_A|c8y_B'])
    expect(rt.hasHook('alarms:create:*:c8y_B|c8y_A')).toBe(true)
    expect(rt.hasHook('alarms:create:*:c8y_A|c8y_B|c8y_A')).toBe(true) // duplicates collapse
    const socket = await socketFor(posted[0]!.subscription)
    socket.emit('message', frame('alarms', 'CREATE', '1', { id: '1', type: 'c8y_A', source: { id: '1' } }))
    await waitFor(() => seen.length >= 2)
    expect(seen.sort()).toEqual(['key:1', 'obj:1'])
    await rt.close()
  })

  it('canonical keys keep ":", "#", spaces and quotes literal, escape only "|" and "%", and round-trip', () => {
    const { rt } = filterClient({ autoStart: false, ensureSubscription: false })
    rt.events.onCreate({ source: '42', type: ['my type', 'a:b#c', 'o\'k', 'p|q', '100%', 'back\\slash'] }, () => {})
    const [key] = rt.hookKeys()
    expect(key).toBe('events:create:42:100%25|a:b#c|back\\slash|my type|o\'k|p%7Cq')
    expect(rt.hasHook(key!)).toBe(true)
    expect(rt.hasHook('events:create:42:p%7cq|back\\slash|100%25|a:b#c|my type|o\'k')).toBe(true) // case-insensitive escapes, any order
    expect(rt.unsubscribe(key!)).toMatchObject({ removed: true, count: 1 })
    expect(rt.hookKeys()).toEqual([])
    // a type with ":" in the key form needs no escaping
    rt.hook('events:create:*:lora:uplink', () => {})
    expect(rt.hookKeys()).toEqual(['events:create:*:lora:uplink'])
  })

  it('rejects filters where they cannot apply, and malformed keys', () => {
    const { rt } = filterClient({ autoStart: false, ensureSubscription: false })
    const fn = (): void => {}
    // runtime guards (the types already forbid these; cast to reach them)
    const ops = rt.operations as unknown as { onCreate: (s: unknown, h: () => void) => void }
    expect(() => ops.onCreate({ source: '*', type: 'x' }, fn)).toThrow(/not supported for operations/)
    // (cast the key to an allowed literal so the compile-time rejection is bypassed; runtime still sees the real string)
    expect(() => rt.hook('operations:create:*:x' as 'operations:create:*', fn)).toThrow(/not supported for operations/)
    expect(() => rt.alarms.onCreate({ source: '*', type: [] }, fn)).toThrow(/invalid type filter \[\]/)
    expect(() => rt.alarms.onCreate({ source: '*', type: '' }, fn)).toThrow(/invalid type filter ""/)
    expect(() => rt.hook('alarms:create:*:' as 'alarms:create:*', fn)).toThrow(/invalid type filter/)
    expect(() => rt.hook('alarms:create:*:a||b' as 'alarms:create:*', fn)).toThrow(/doubled "\|"/)
    expect(() => (rt.alarms.onCreate as (a: unknown, b: unknown) => void)({ source: 7, type: 'x' }, fn)).toThrow(/must be a string/)
    expect(() => (rt.alarms.onCreate as (a: unknown, b?: unknown) => void)('*')).toThrow(/handler is missing/)
    // query/remove methods never throw: a malformed key is simply "no such key"
    expect(rt.hasHook('alarms:create:*:')).toBe(false)
    expect(rt.unsubscribe('alarms:create:*:a||b')).toEqual({ removed: false, count: 0, subscriptionDeleted: false })
    expect(rt.detach('alarms:create:*:')).toEqual({ removed: false, count: 0, subscriptionDeleted: false })
    expect(rt.hookKeys()).toEqual([])
  })

  it('delete-on-empty removes only the filtered subscription and closes only its socket', async () => {
    MockSocket.reset()
    const { rt, posted, deleted } = filterClient()
    rt.alarms.onCreate('*', () => {})
    const off = rt.alarms.onCreate({ source: '*', type: 'c8y_A' }, () => {})
    await rt.start()
    const filteredSub = posted.find((p) => p.subscriptionFilter?.typeFilter)!
    const plain = await socketFor('c8yRealtimeAlarms')
    const filtered = await socketFor(filteredSub.subscription)
    off()
    await delay(20)
    expect(deleted).toEqual([filteredSub.id])
    expect(filtered.closedWith).toBeDefined()
    expect(plain.closedWith).toBeUndefined()
    expect(rt.hookKeys()).toEqual(['alarms:create:*'])
    await rt.close()
  })

  it('re-registering the same filter after removal recreates it on the SAME topic name', async () => {
    MockSocket.reset()
    const { rt, posted } = filterClient({ autoStart: false })
    const off = rt.alarms.onCreate({ source: '7', type: 'c8y_A' }, () => {})
    await rt.start()
    off()
    await delay(20)
    rt.alarms.onCreate({ source: '7', type: 'c8y_A' }, () => {})
    await rt.start()
    expect(posted).toHaveLength(2)
    expect(posted[0]!.subscription).toBe(posted[1]!.subscription)
    await rt.close()
  })

  it('narrows the payload type: literal `type`, and an explicit payload generic that must match the filter', () => {
    const { rt } = filterClient({ autoStart: false, ensureSubscription: false })
    // plain user-defined shapes — no helper types; base Alarm fields are added by the namespace
    interface TempAlarm { type: 'c8y_TemperatureAlarm', c8y_Temperature: { T: { value: number } } }
    interface DoorAlarm { type: 'c8y_DoorAlarm', c8y_Door: { open: boolean } }

    rt.alarms.onCreate({ source: '*', type: 'c8y_X' }, (a) => {
      expectTypeOf(a.type).toEqualTypeOf<'c8y_X'>()
    })
    rt.alarms.onCreate({ source: '*', type: ['c8y_X', 'c8y_Y'] }, (a) => {
      expectTypeOf(a.type).toEqualTypeOf<'c8y_X' | 'c8y_Y'>()
    })
    rt.alarms.onCreate<TempAlarm>({ source: '*', type: 'c8y_TemperatureAlarm' }, (a) => {
      expectTypeOf(a.c8y_Temperature.T.value).toEqualTypeOf<number>()
      expectTypeOf(a.severity).toEqualTypeOf<Alarm['severity']>() // base fields still there
      expectTypeOf(a.type).toEqualTypeOf<'c8y_TemperatureAlarm'>()
    })
    rt.alarms.onCreate<TempAlarm | DoorAlarm>({ source: '*', type: ['c8y_TemperatureAlarm', 'c8y_DoorAlarm'] }, (a) => {
      if (a.type === 'c8y_DoorAlarm')
        expectTypeOf(a.c8y_Door.open).toEqualTypeOf<boolean>()
    })
    rt.hook('alarms:create:*:c8y_Z', (a) => {
      expectTypeOf(a.type).toEqualTypeOf<'c8y_Z'>()
    })
    rt.hook('events:create:12345:c8y_A|c8y_B', (ev) => {
      expectTypeOf(ev.type).toEqualTypeOf<'c8y_A' | 'c8y_B'>()
    })
    rt.hook('events:create:*:weird%7Ctype', (ev) => {
      expectTypeOf(ev.type).toEqualTypeOf<string>() // escapes → no narrowing
    })
    rt.hook<'alarms:create:*:c8y_TemperatureAlarm', TempAlarm>('alarms:create:*:c8y_TemperatureAlarm', (a) => {
      expectTypeOf(a.c8y_Temperature.T.value).toEqualTypeOf<number>()
      expectTypeOf(a.severity).toEqualTypeOf<Alarm['severity']>()
    })
    rt.hook<'alarms:create:*:c8y_TemperatureAlarm|c8y_DoorAlarm', TempAlarm | DoorAlarm>('alarms:create:*:c8y_TemperatureAlarm|c8y_DoorAlarm', (a) => {
      if (a.type === 'c8y_DoorAlarm')
        expectTypeOf(a.c8y_Door.open).toEqualTypeOf<boolean>()
    })
    rt.hook('managedobjects:create:*:c8y_Device', (mo) => {
      expectTypeOf(mo.type).toEqualTypeOf<'c8y_Device'>()
    })
    // onDelete / onAny accept a filter but never narrow (a DELETE payload has no `type`)
    rt.alarms.onDelete({ source: '*', type: 'c8y_X' }, (d) => {
      expectTypeOf(d).toEqualTypeOf<DeletionPayload>()
    })
    rt.hook('alarms:delete:*:c8y_X', (d) => {
      expectTypeOf(d).toEqualTypeOf<DeletionPayload>()
    })
    rt.alarms.onAny({ source: '7', type: ['c8y_X', 'c8y_Y'] }, (p) => {
      expectTypeOf(p).toEqualTypeOf<Alarm | DeletionPayload>()
    })
    // generic code written against the plain namespace shape still accepts every namespace
    const wire = <P>(h: TypeHooks<P>): TypeHooks<P> => h
    wire(rt.alarms)
    wire(rt.operations)
    // keys built from a variable keep their payload type (regression guard)
    const scope: string = '12345'
    rt.hook(`alarms:create:${scope}`, (a) => {
      expectTypeOf(a).toEqualTypeOf<Alarm>()
    })
    rt.hook(`alarms:create:*:${scope}`, (a) => {
      expectTypeOf(a.type).toEqualTypeOf<string>()
    })
    rt.alarms.onCreate('*', (a) => {
      expectTypeOf(a.type).toEqualTypeOf<string>()
    })

    // compile-time only: these must be type errors (and would throw at runtime), so never call this
    const _mustNotCompile = (): void => {
      // @ts-expect-error the filter must be assignable to the generic's `type`
      rt.alarms.onCreate<TempAlarm>({ source: '*', type: 'c8y_DoorAlarm' }, () => {})
      // @ts-expect-error one of the listed types is outside the union
      rt.alarms.onCreate<TempAlarm | DoorAlarm>({ source: '*', type: ['c8y_TemperatureAlarm', 'c8y_Other'] }, () => {})
      // @ts-expect-error a payload generic needs a filtered scope
      rt.alarms.onCreate<TempAlarm>('*', () => {})
      // @ts-expect-error operations have no `type`
      rt.operations.onCreate({ source: '*', type: 'x' }, () => {})
      // @ts-expect-error managedobjects:create is all-devices only
      rt.managedObjects.onCreate({ source: '123', type: 'x' }, () => {})
      // @ts-expect-error the key's type must match the generic's `type`
      rt.hook<'alarms:create:*:c8y_DoorAlarm', TempAlarm>('alarms:create:*:c8y_DoorAlarm', () => {})
      // @ts-expect-error operations keys cannot carry a filter
      rt.hook('operations:create:*:x', () => {})
      // @ts-expect-error empty type in the filter segment
      rt.hook('alarms:create:*:', () => {})
      // @ts-expect-error empty type in the filter segment
      rt.hook('alarms:create:*:a||b', () => {})
      // @ts-expect-error empty type in the filter segment
      rt.hook('alarms:create:*:a|', () => {})
    }
    expect(typeof _mustNotCompile).toBe('function')
    rt.managedObjects.onCreate({ source: '*', type: 'c8y_Device' }, (mo) => {
      expectTypeOf(mo.type).toEqualTypeOf<'c8y_Device'>()
    })
  })
})
