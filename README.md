# c8y-realtime

A small, typed TypeScript SDK for **Cumulocity Notification 2.0** realtime streams.

- Typed handlers per type, action, and device — `rt.alarms.onCreate('12345', (a) => …)`.
- No dependency on `@c8y/client`. Native `fetch`, and `ws` for the WebSocket.
- Handles the token, connection, keep-alive, reconnect, and de-duplication for you.
- ESM only, strict TypeScript, Node ≥ 20.

Two ways to use it:

1. **High-level client** (`createRealtimeClient`) — typed hooks. Start here.
2. **Low-level core** (`createNotificationClient`) — subscriptions REST + a raw consumer.

## Install

```sh
pnpm add c8y-realtime ws
```

`ws` is used for the WebSocket in Node. In the browser (or any runtime with a global `WebSocket`) it's picked up automatically; you can also pass your own via `webSocketImpl`.

## Quick start

```ts
import { createRealtimeClient } from 'c8y-realtime'

const rt = createRealtimeClient({
  name: 'myApp', // required, unique per app (alphanumeric)
  baseUrl: process.env.C8Y_BASEURL!,
  tenant: process.env.C8Y_TENANT!,
  user: process.env.C8Y_USER!,
  password: process.env.C8Y_PASSWORD!,
})

// First argument is the device: '*' for all devices, or a device id.
rt.alarms.onCreate('*', (alarm) => console.log(alarm.severity, alarm.text))
rt.alarms.onCreate('12345', (alarm) => console.log(alarm.text))
rt.events.onDelete('*', ({ id }) => console.log('deleted', id))
rt.measurements.onCreate('12345', (m) => console.log(m.type, m.time))

// Same thing as a single key string:
rt.hook('alarms:create:*', (alarm) => console.log(alarm.severity))

// Every notification:
rt.onAny((payload, n) => console.log(n.description.type, n.action))

await rt.close()
```

Each register returns a function that removes that handler. Payloads are fully typed (`Alarm`, `C8yEvent`, `Measurement`, `ManagedObject`, `Operation`; a delete gives `{ id }`).

## Devices (scope)

The device is always the first argument: `'*'` for all devices, or a device id. Some types only allow one or the other, and the types enforce it:

| Type / action                          | `'*'` (all) | a device id  |
| -------------------------------------- | ----------- | ------------ |
| `managedObjects.onCreate`              | ✓ (only)    | ✗            |
| `managedObjects.onUpdate` / `onDelete` | ✗           | ✓ (required) |
| `measurements.*`                       | ✗           | ✓ (required) |
| `alarms` / `events` / `operations` .*  | ✓           | ✓            |

`onAny` is the exception: its device argument is optional (`rt.onAny(fn)` = all).

## API

### `createRealtimeClient(options)`

Required: `name` (unique per app, alphanumeric), plus `baseUrl`, `tenant`, `user`, `password`.

| Option                      | Default | What it does                                                         |
| --------------------------- | ------- | -------------------------------------------------------------------- |
| `deleteSubscriptionOnEmpty` | `true`  | Delete a device's remote subscription when its last handler is gone. |
| `deleteSubscriptionsOnClose`| `false` | Delete every subscription this client created on `close()`.          |
| `autoAck`                   | `true`  | Acknowledge each message after its handlers finish.                  |
| `autoStart`                 | `true`  | Connect as soon as handlers are registered.                          |
| `ensureSubscription`        | `true`  | Create the subscription on the platform if missing.                  |
| `dedupe`                    | `true`  | Drop identical messages redelivered on the same stream.              |
| `subscription`              | —       | `{ apis?, nonPersistent? }` (see [persistence](#persistence)).       |

Also accepts `resilience`, `logger`, `webSocketImpl`, `fetchImpl`.

### Registering handlers

Each returns an `Unsubscribe` function. Every register also takes an optional `label` (unique per client) so you can remove it later without keeping the returned function.

```ts
rt.alarms.onCreate(scope, handler, label?)      // scope: '*' or a device id
rt.measurements.onUpdate(deviceId, handler)     // device id required
rt.managedObjects.onCreate('*', handler)        // all devices only
rt.hook('alarms:create:12345', handler, label?) // key = '<type>:<action>:<scope>'
rt.onAny(handler, label?)                        // or rt.onAny(deviceId, handler)
```

### Removing handlers

```ts
const off = rt.alarms.onCreate('12345', handler)
off()                              // remove this one handler

rt.unhook('myLabel')               // remove the one handler with that label
// → { removed, subscriptionDeleted }

rt.unsubscribe('alarms:create:12345')
// remove ALL handlers for the key; delete the remote subscription when empty
// → { removed, count, subscriptionDeleted }

rt.detach('alarms:create:12345')
// remove ALL handlers but KEEP the remote subscription (see below)
// → { removed, count, subscriptionDeleted: false }

rt.hasHook('alarms:create:12345')  // → boolean
rt.hookKeys()                      // → ['alarms:create:12345', …]
```

`subscriptionDeleted` is `true` only when that removal left the device with no handlers _and_ the remote subscription was actually deleted. A key's handlers share one subscription with the other actions on the same device, so it isn't deleted while any of them remain.

### Control

`rt.start()` connects, `rt.close()` disconnects, `rt.subscriptions` is the REST API below.

## Subscription lifecycle

One subscription exists per `(type, device)` for as long as it has at least one handler. When the last handler for a device is removed:

- **`deleteSubscriptionOnEmpty: true`** (default) — the remote subscription is deleted, and the type's connection is closed once its last device is gone.
- **`deleteSubscriptionOnEmpty: false`** — the subscription is kept.
- **`unsubscribe(key)`** always deletes; **`detach(key)`** always keeps.

Keep a subscription (`detach`, or the option off) only if you plan to resume it — re-registering then reuses it instead of recreating it. A kept subscription with no handlers still counts against your quota, and if you turned `autoAck` off, its backlog grows unacknowledged until it hits a limit.

## Persistence

`nonPersistent` is a **Cumulocity** delivery mode — the SDK just forwards it (onto both the subscription and the token, so they agree). It's not something the SDK implements.

- **Persistent** (default, `subscription: { nonPersistent: false }`) — Cumulocity keeps a durable per-consumer queue. If your connection drops, notifications sent during the gap pile up server-side; on reconnect you resume from your last-acked position and drain the backlog, so nothing is missed (within the platform's TTL/quota). This is what makes the ack meaningful.
- **Non-persistent** (`subscription: { nonPersistent: true }`) — no server-side queue; you only receive messages while connected, and anything sent during a disconnect is lost. Cheaper on the platform — a fit for high-rate "current value only" feeds where a stale backlog is worthless.

<details>
<summary>Low-level core — <code>createNotificationClient</code></summary>

```ts
import { createNotificationClient, SubscriptionApis } from 'c8y-realtime'

const client = createNotificationClient({ baseUrl, tenant, user, password })

await client.subscriptions.ensure({
  context: 'tenant',
  subscription: 'myDemo', // alphanumeric
  subscriptionFilter: { apis: [SubscriptionApis.measurements] },
})

const consumer = client.subscribe('myDemo', { subscriber: 'myService' })
for await (const n of consumer) {
  console.log(n.action, n.description.type, n.description.sourceId, n.payload)
  break // leaving the loop acks the last item and closes the consumer
}
await client.close()
```

- `client.subscriptions`: `list`, `get`, `create`, `ensure` (409 = already exists), `delete` (404 = already gone).
- `client.subscribe(name, options?)`: async-iterable consumer. Options: `subscriber`, `autoAck` (default `true`), `nonPersistent`, `shared`, `expiresInMinutes`, `consumerName`, `signal`. Set `autoAck: false` and call `n.ack()` yourself for at-least-once.
- `client.close()` closes every consumer.

</details>

## What's not included, and why

<details>
<summary>No message filtering (no <code>typeFilter</code> / <code>fragmentsToCopy</code>)</summary>

Every subscription forwards the full message; filter inside your handler if you want a subset.

Cumulocity can't change a subscription in place — only delete and recreate it. Changing a filter would mean a delete→create (can drop messages) or create→delete (can double-deliver), so we don't filter on the server at all. The upside: the subscription never changes, and any number of handlers can share one stream for the same device with no conflict. The cost: the full message reaches your process, and the platform no longer drops fields before they get to you.

</details>

<details>
<summary>No changing a live subscription</summary>

For the same reason — there's no safe in-place update — the client never edits a subscription after creating it. Removing the last handler deletes it (see [lifecycle](#subscription-lifecycle)); a new registration creates a fresh one.

</details>

<details>
<summary>No options object — just a device and a handler</summary>

Registers take a positional device (`'*'` or an id) and a handler, plus an optional label. With no per-device filter settings left to pass, an options object added nothing, and one string key (`'<type>:<action>:<scope>'`) stays simple.

</details>

<details>
<summary>Scoped <code>onAny</code> can't be removed by key</summary>

The all-devices firehose (`rt.onAny(fn)`) has the key `'*'` — it's listed by `hookKeys()` and removable via `unsubscribe('*')` / `hasHook('*')` (or register it with `rt.hook('*', fn)`). But a **scoped** firehose (`rt.onAny(deviceId, fn)`) and a per-type one (`rt.alarms.onAny(...)`) span all actions, so they have no `'<type>:<action>:<scope>'` key — remove those with the returned function or by `label`.

</details>

<details>
<summary>Handlers on the same key run one after another</summary>

If several handlers share a key, they run in registration order, each awaited before the next — not in parallel.

</details>

## Development

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test:run   # unit tests; live tests run when a .env with credentials is present
pnpm build
```

The live tests (`tests/e2e`) read throwaway credentials from a gitignored `.env` and are skipped without them.

## License

MIT
