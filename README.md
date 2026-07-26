# c8y-realtime

A standalone, dependency-light TypeScript SDK for the **Cumulocity IoT Notification 2.0** API.

- 🎯 **Typed, ergonomic hooks** — `rt.alarms.onCreate({ id: '12345' }, (alarm) => …)` and `rt.hook({ key: 'measurements:create:12345' }, (m) => …)`, both fully typed per type/action/scope
- 🚫 **Zero dependency on `@c8y/client`** — native `fetch` for REST, [`ws`](https://github.com/websockets/ws) for the consumer WebSocket
- 🧱 **Framework-agnostic core** — the high-level hooks sit on a plain async-iterable core (no NestJS, no DI, no RxJS)
- ♻️ **Resilient** — token refresh, ping/pong keep-alive, automatic reconnect with backoff, clean teardown
- ✅ **At-least-once** — auto-ack after processing, or explicit `.ack()`
- 🧩 **ESM only, strict TypeScript**, Node ≥ 20

There are two layers, use whichever fits:

1. **High-level realtime client** (`createRealtimeClient`) — typed per-type/per-action hooks + fluent namespaces. Start here.
2. **Low-level core** (`createNotificationClient`) — subscriptions REST + a resilient async-iterable consumer. Full control.

## Installation

```sh
pnpm add c8y-realtime ws
# or
npm install c8y-realtime ws
```

> `ws` is used by default in Node for WebSocket ping/pong keep-alive. In the browser (or any runtime with a global `WebSocket`) it is picked up automatically, and you can also inject your own via `webSocketImpl`.

## Quick start (high-level, typed hooks)

```ts
import { createRealtimeClient } from 'c8y-realtime'

const rt = createRealtimeClient({
  name: 'myApp', // required, unique per app — see below
  baseUrl: process.env.C8Y_REALTIME_URL!,
  tenant: process.env.C8Y_REALTIME_TENANT!,
  user: process.env.C8Y_REALTIME_USER!,
  password: process.env.C8Y_REALTIME_PASSWORD!,
})

// Every register takes an options object first (never a bare string) so `{ … }`
// gets clean completion. Payloads are fully typed (alarm: Alarm, m: Measurement, …)
rt.alarms.onCreate({}, (alarm) => console.log(alarm.severity, alarm.text)) // all devices
rt.alarms.onCreate({ id: '12345' }, (alarm) => console.log(alarm.text)) // one device
rt.events.onDelete({}, ({ id }) => console.log('event deleted', id)) // DELETE → { id }
rt.operations.onCreate({}, (op) => console.log(op.status))

// managedObjects: CREATE is all-devices only; UPDATE/DELETE are device-scoped.
rt.managedObjects.onCreate({}, (mo) => console.log('new device', mo.id))
rt.managedObjects.onUpdate({ id: '12345' }, (mo) => console.log('updated', mo.id))

// measurements have no tenant-wide feed → a device id is required (type-enforced):
rt.measurements.onCreate({ id: '12345' }, (m) => console.log(m.type, m.time))

// Equivalent hookable-style keys (also typed). The optional third key segment is
// the device id; omitted means all devices (where the platform allows it):
rt.hook({ key: 'alarms:create' }, (alarm) => console.log(alarm.severity)) // all devices
rt.hook({ key: 'measurements:create:12345' }, (m) => console.log(m.type)) // device 12345

// Firehose:
rt.onAny((payload, n) => console.log(n.description.type, n.action))

// The client auto-ensures subscriptions, mints the token, connects, keeps alive,
// refreshes the token, reconnects, and de-dupes — all internally. Auto-acks after
// each handler resolves. On shutdown:
await rt.close()
```

**How scoping maps to Cumulocity** (the types enforce this — see the matrix). The scope is always the **first argument**: `'*'` for all devices, or a source id — there is no bare-handler form (a required first arg keeps object-inference unambiguous).

| Type / Action                           | All Devices (`'*'`) | Specific Device Id |
| --------------------------------------- | ------------------- | ------------------ |
| `managedObjects.onCreate`               | ✓                   | ✗                  |
| `managedObjects.onUpdate` / `onDelete`  | ✗                   | ✓ (required)       |
| `measurements.*`                        | ✗                   | ✓ (required)       |
| `alarms` / `events` / `operations` `.*` | ✓                   | ✓                  |

Under the hood the client uses **one topic + one consumer/websocket per notification type** (plus one for `onAny`). Each `(type, scope)` you register is its own **single-type** subscription (`tenant`, or per-device `mo`) — never merged with another type and never re-created — funneling into that type's topic; notifications are routed to your handlers by `sourceId`. So consumers scale with the number of _types_ you use (≈5), not the number of devices, and removing one handler never disturbs another. Set `deleteSubscriptionsOnClose: true` for ephemeral clients that should leave nothing behind.

> Topic and subscriber names must be **alphanumeric** (Cumulocity rejects other characters). The defaults already follow this.

### Per-scope filters & delivery

The options object also carries a `typeFilter` (match the message `type`) and/or `fragmentsToCopy` (trim the forwarded payload to specific fragments) alongside the `id` — applied to that scope's subscription.

- **`typeFilter`** — pass the raw type name(s) as a string or array; they're **quoted and combined with OData `or` for you** (internal quotes escaped). Passed as a literal, it also **narrows the payload's `type`** to that union.
- **`fragmentsToCopy`** — restricts forwarded messages to these custom fragments. Known fields (`id`, `source`, `type`, `time`, `self`, and type-specific ones like an alarm's `severity`/`status`) are **always kept**; only non-listed _custom_ fragments are dropped. Passed as an **array literal**, it also **narrows the payload type** to the known fields + exactly those fragment keys (the `[string]: unknown` catch-all is removed, so an unlisted fragment is a compile error).

```ts
rt.measurements.onCreate(
  { id: '12345', typeFilter: ['c8y_Temperature', 'c8y_Pressure'], fragmentsToCopy: ['c8y_Temperature'] },
  (m) => {
    // m.type is narrowed to 'c8y_Temperature' | 'c8y_Pressure' (from typeFilter)
    console.log(m.type, m.id, m.source, m.c8y_Temperature) // known fields + copied fragment (unknown)
    // m.c8y_Speed  ❌ compile error — not copied
  },
) // → typeFilter: "'c8y_Temperature' or 'c8y_Pressure'"

// hook form: pass { key, ...filter }
rt.hook({ key: 'alarms:create:12345', typeFilter: 'c8y_TamperEvent' }, (a) => {}) // → "'c8y_TamperEvent'"
```

A scope's filter is set when its subscription is first created — keep it consistent across handlers for the same `(type, scope)`.

**Delivery guarantee** — `subscription.nonPersistent`:

```ts
const rt = createRealtimeClient({ ...creds, name: 'myApp', subscription: { nonPersistent: true } })
```

- `false` (default, **persistent**): reliable — a backlog + your ack position survive reconnects, so nothing is missed during a blip/restart (within TTL/quota).
- `true` (**non-persistent**): in-memory only; on reconnect you jump to the latest message and miss anything during the outage. Cheaper; good for high-rate "current value only" feeds. The SDK sets it on both the subscription and the token so they match.

## Quick start (low-level core, single tenant)

```ts
import { createNotificationClient, SubscriptionApis } from 'c8y-realtime'

// Exactly what a multitenant microservice subscription yields:
const client = createNotificationClient({
  baseUrl: process.env.C8Y_REALTIME_URL!, // e.g. https://mytenant.eu-latest.cumulocity.com
  tenant: process.env.C8Y_REALTIME_TENANT!,
  user: process.env.C8Y_REALTIME_USER!,
  password: process.env.C8Y_REALTIME_PASSWORD!,
})

// 1) Ensure a subscription exists (HTTP 409 "already exists" is treated as success).
//    Note: the subscription name must be ALPHANUMERIC.
await client.subscriptions.ensure({
  context: 'tenant',
  subscription: 'c8yRealtimeDemo',
  subscriptionFilter: { apis: [SubscriptionApis.managedobjects] },
})

// 2) Subscribe. The client mints the token, opens the WebSocket, and handles
//    keep-alive, token refresh and reconnection internally.
const consumer = client.subscribe('c8yRealtimeDemo', { subscriber: 'myService' })

// 3) Consume. With the default autoAck, each notification is acknowledged once
//    the loop body finishes processing it.
for await (const notification of consumer) {
  console.log(
    notification.action, // 'CREATE' | 'UPDATE' | 'DELETE' | ...
    notification.description.type, // 'managedobjects' | 'alarms' | ...
    notification.description.sourceId, // the source (device) id
    notification.payload, // parsed JSON payload
  )
  break // leaving the loop acks the last item and closes the consumer
}

await client.close()
```

### Explicit acknowledgement (at-least-once)

```ts
const consumer = client.subscribe('c8yRealtimeDemo', {
  subscriber: 'myService',
  autoAck: false,
})

for await (const notification of consumer) {
  await handle(notification.payload)
  notification.ack() // acknowledge only after successful processing
}
```

## Quick start (multi-tenant fan-out)

`createMultiTenantClient` builds one client per credential, keyed by tenant id —
ideal for a microservice subscribed to many tenants.

```ts
import { createMultiTenantClient } from 'c8y-realtime'

const clients = createMultiTenantClient('https://mycloud.cumulocity.com', [
  { baseUrl: '', tenant: 't1', user: 'svc', password: 'secret1' },
  { baseUrl: '', tenant: 't2', user: 'svc', password: 'secret2' },
])

for (const [tenantId, client] of clients) {
  await client.subscriptions.ensure({
    context: 'tenant',
    subscription: 'c8yRealtimeDemo',
    subscriptionFilter: { apis: ['alarms'] },
  })

  const consumer = client.subscribe('c8yRealtimeDemo', { subscriber: `svc${tenantId}` })
  void (async () => {
    for await (const n of consumer)
      console.log(tenantId, n.action, n.description.type)
  })()
}

// later, on shutdown:
await Promise.all([...clients.values()].map((c) => c.close()))
```

## API

### `createRealtimeClient(options)` — high-level

`options`: `{ name, baseUrl, tenant, user, password }` — **`name` is required** and
must be **unique per application** (alphanumeric). It's the base for this client's
per-type topic and consumer names (`<name>Alarms`, …); two independently-deployed
apps that reuse a name become **competing consumers** on the same stream and each
receives only part of the notifications. Plus optional `subscription`
(`{ apis?, nonPersistent? }`), `autoAck?` (default `true`),
`ensureSubscription?` (default `true`), `autoStart?` (default `true`),
`dedupe?` (default `true`), `deleteSubscriptionsOnClose?` (default `false`), and
the same `resilience`/`logger`/`webSocketImpl`/`fetchImpl`.

Returns a `RealtimeClient`:

- **Namespaces** — `rt.alarms`, `rt.events`, `rt.operations` (each `onCreate`/`onUpdate`/`onDelete`/`onAny`, all taking `(options, handler)` where `options` is `{ id?, typeFilter?, fragmentsToCopy? }` — `{}` = all devices, `{ id }` = one); `rt.managedObjects` (`onCreate({ … }, handler)` all-only, `onUpdate`/`onDelete({ id, … }, handler)` id-required); `rt.measurements` (all methods id-required: `({ id, … }, handler)`). DELETE payloads are `{ id }`. The first argument is **always an options object** (never a bare string) so `{ … }` gets clean completion.
- **`rt.hook({ key: '<type>:<action>[:<sourceId>]', … }, handler)`** — typed hookable-style keys; the third key segment is the device id (required where the matrix requires it).
- **`rt.onAny([sourceId,] handler)`** — every notification (optionally one device's feed).
- **`rt.subscriptions`** — the underlying REST API. **`rt.start()`** / **`rt.close()`**.

Every registration returns an `Unsubscribe` function. Payload types: `Alarm`,
`C8yEvent`, `Measurement`, `ManagedObject`, `Operation`, and `DeletionPayload`.

### `createNotificationClient(options)` — low-level core

`options`: `{ baseUrl, tenant, user, password }` plus optional
`resilience`, `logger`, `webSocketImpl`, `fetchImpl`.

Returns a `NotificationClient`:

- **`client.subscriptions`** — REST against `notification2/subscriptions`:
  - `list(filter?)` → `SubscriptionCollection`
  - `get(id)` → `SubscriptionResponse`
  - `create(sub)` → `SubscriptionResponse`
  - `ensure(sub)` → `SubscriptionResponse` (409 treated as success)
  - `delete(id)` → `void` (404 treated as already-deleted)
- **`client.subscribe(name, options?)`** → async-iterable consumer
  - `subscriber?` — consumer identity for the token (default `"<name>-consumer"`)
  - `autoAck?` — acknowledge after processing (default `true`)
  - `nonPersistent?`, `shared?`, `expiresInMinutes?`, `consumerName?`, `signal?`
- **`client.createToken(options)`** → `{ token }` (usually not needed directly)
- **`client.close()`** — close every active consumer

### `createMultiTenantClient(baseUrl, credentials[])`

Returns `Map<tenantId, NotificationClient>`. Each credential may carry its own
`baseUrl`; otherwise the shared `baseUrl` is used.

### `SubscriptionApis`

`alarms`, `alarmsWithChildren`, `events`, `eventsWithChildren`, `managedobjects`,
`measurements`, `operations`, and `all` (`'*'`).

### `Notification`

| Field                | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `ackHeader`          | Opaque acknowledgement id (first header line)        |
| `description`        | `{ tenantId, type, sourceId, raw }`                  |
| `action`             | `CREATE` \| `UPDATE` \| `DELETE` \| …                |
| `payload`            | Parsed JSON payload (or raw string)                  |
| `rawPayload` / `raw` | Raw payload / full frame text                        |
| `ack()`              | Acknowledge on the connection the message arrived on |

## Resilience

- **Token refresh** — a fresh token is minted before every (re)connection.
- **Keep-alive** — WebSocket ping every `pingIntervalMs` (default 60s); a missing
  pong within `pongTimeoutMs` (default 10s) is treated as a dead socket.
- **Reconnect** — automatic, with exponential backoff between `initialBackoffMs`
  and `maxBackoffMs`. Transient failures retain the last-known-good subscription
  state rather than tearing down a healthy setup.
- **Teardown** — `consumer.close()` / `client.close()` set an internal closing
  flag: no error is surfaced and no reconnect is attempted.

## Development

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test:run   # unit tests; live e2e runs too when a .env with credentials is present
pnpm build
```

The live integration test (`tests/e2e`) reads throwaway credentials from a
gitignored `.env` (`C8Y_REALTIME_URL/TENANT/USER/PASSWORD`) and is skipped when
they are absent.

## License

MIT
