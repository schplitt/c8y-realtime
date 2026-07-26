import { describe, expect, it } from 'vitest'
import { createRealtimeClient } from '../../src/realtime'
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

describe('realtimeClient — one topic + consumer per type', () => {
  it('routes typed CREATE notifications to the matching namespace', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    const received: Alarm[] = []
    rt.alarms.onCreate({}, (alarm) => {
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
    rt.events.onDelete({}, (payload) => {
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
    rt.alarms.onCreate({ id: '111' }, () => {})
    rt.alarms.onCreate({ id: '222' }, () => {})
    rt.alarms.onCreate({}, () => {}) // all-devices, same Alarms topic
    await socketFor('c8yRealtimeAlarms')
    await delay(30)
    // three alarm registrations across two devices + tenant → ONE alarms consumer
    expect(MockSocket.instances.length).toBe(1)
    await rt.close()
  })

  it('uses a separate consumer per distinct type', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    rt.alarms.onCreate({ id: '111' }, () => {})
    rt.events.onCreate({ id: '111' }, () => {})
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
    rt.alarms.onCreate({}, (a) => {
      all.push(String(a.id))
    })
    rt.alarms.onCreate({ id: '111' }, (a) => {
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

describe('realtimeClient — subscriptions are single-type, never merged', () => {
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
    rt.alarms.onCreate({ id: '2468' }, () => {})
    rt.events.onCreate({ id: '2468' }, () => {})
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
    rt.alarms.onCreate({}, () => {}) // tenant
    rt.measurements.onCreate({ id: '145075' }, () => {}) // mo
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

  it('quotes a single typeFilter name and applies fragmentsToCopy (namespace object)', async () => {
    MockSocket.reset()
    const { rt, posted } = capturingClient()
    rt.measurements.onCreate(
      { id: '2468', typeFilter: 'c8y_Temperature', fragmentsToCopy: ['c8y_Temperature'] },
      (m) => {
        // Known fields kept; the copied fragment is a valid key…
        expect(m.id).toBeDefined()
        expect(m.c8y_Temperature).toBeUndefined()
        // …and a non-copied fragment is a compile error (catch-all removed).
        // @ts-expect-error c8y_Speed was not copied
        expect(m.c8y_Speed).toBeUndefined()
      },
    )
    await rt.start()
    const meas = posted.find((p) => p.subscription === 'c8yRealtimeMeasurements')
    expect(meas?.source?.id).toBe('2468')
    expect(meas?.subscriptionFilter?.typeFilter).toBe('\'c8y_Temperature\'')
    expect(meas?.fragmentsToCopy).toEqual(['c8y_Temperature'])
    await rt.close()
  })

  it('accepts filter options in the hook object form', async () => {
    MockSocket.reset()
    const { rt, posted } = capturingClient()
    rt.hook({ key: 'alarms:create:2468', typeFilter: 'c8y_TamperEvent', fragmentsToCopy: ['f'] }, () => {})
    await rt.start()
    const alarms = posted.find((p) => p.subscription === 'c8yRealtimeAlarms')
    expect(alarms?.source?.id).toBe('2468')
    expect(alarms?.subscriptionFilter?.typeFilter).toBe('\'c8y_TamperEvent\'')
    expect(alarms?.fragmentsToCopy).toEqual(['f'])
    await rt.close()
  })

  it('builds the OData typeFilter from an array of type names', async () => {
    MockSocket.reset()
    const { rt, posted } = capturingClient()
    rt.alarms.onCreate({ typeFilter: ['c8y_TamperEvent', 'c8y_UnavailabilityAlarm'] }, () => {})
    await rt.start()
    const alarms = posted.find((p) => p.subscription === 'c8yRealtimeAlarms')
    expect(alarms?.subscriptionFilter?.typeFilter).toBe('\'c8y_TamperEvent\' or \'c8y_UnavailabilityAlarm\'')
    await rt.close()
  })

  it('escapes internal single quotes in a type name', async () => {
    MockSocket.reset()
    const { rt, posted } = capturingClient()
    rt.alarms.onCreate({ typeFilter: 'O\'Brien' }, () => {})
    await rt.start()
    const alarms = posted.find((p) => p.subscription === 'c8yRealtimeAlarms')
    expect(alarms?.subscriptionFilter?.typeFilter).toBe('\'O\'\'Brien\'')
    await rt.close()
  })

  it('narrows the payload `type` to the typeFilter union', async () => {
    MockSocket.reset()
    const { rt } = capturingClient()
    rt.alarms.onCreate({ typeFilter: ['c8y_TamperEvent', 'c8y_UnavailabilityAlarm'] }, (a) => {
      // a.type is narrowed to the union — this assignment only compiles if so:
      const t: 'c8y_TamperEvent' | 'c8y_UnavailabilityAlarm' = a.type
      expect(t).toBeDefined()
      // @ts-expect-error a.type is not assignable to an unrelated literal
      const other: 'nope' = a.type
      expect(other).toBeDefined()
    })
    await rt.close()
  })
})

describe('realtimeClient — hookable-style keys', () => {
  it('routes via "type:action" keys', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    const hits: string[] = []
    rt.hook({ key: 'operations:update' }, (op) => {
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
    rt.hook({ key: 'measurements:create:111' }, (m) => {
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

  it('a type consumer fires only its own handlers, not onAny', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    let alarms = 0
    let any = 0
    rt.alarms.onCreate({}, () => {
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

describe('realtimeClient — acknowledgement', () => {
  it('auto-acks after handlers resolve by default', async () => {
    MockSocket.reset()
    const rt = makeRealtime()
    rt.alarms.onCreate({}, async () => {
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
    rt.alarms.onCreate({}, () => {
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
