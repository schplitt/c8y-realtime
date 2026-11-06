# c8y-realtime

A small, typed TypeScript SDK for **Cumulocity Notification 2.0** realtime streams.

- Typed handlers per type, action, and device — `rt.alarms.onCreate('12345', (a) => …)`.
- No runtime dependencies to speak of — native `fetch` and the runtime's global `WebSocket`. No `@c8y/client`, no `ws`.
- Handles the token, connection, keep-alive, reconnect, and de-duplication for you.
- ESM only, strict TypeScript, Node ≥ 22 (or any runtime with a global `WebSocket`).

Two ways to use it:

1. **High-level client** (`createRealtimeClient`) — typed hooks. Start here.
2. **Low-level core** (`createNotificationClient`) — subscriptions REST + a raw consumer.

## Install

```sh
pnpm add c8y-realtime
```

Uses the runtime's global `WebSocket` — Node 22+, browsers, and other modern runtimes have one built in. On an older runtime, or to use a specific implementation, pass your own via `webSocketImpl` (e.g. `import { WebSocket } from 'ws'`).

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

// Only some types (server-side filter; see "Type filters"):
rt.alarms.onCreate({ source: '*', type: 'c8y_TemperatureAlarm' }, (alarm) => console.log(alarm.type))

// Same thing as a single key string:
rt.hook('alarms:create:*', (alarm) => console.log(alarm.severity))
rt.hook('alarms:create:*:c8y_TemperatureAlarm', (alarm) => console.log(alarm.type))

// Every notification:
rt.onAny((payload, n) => console.log(n.description.type, n.action))

await rt.close()
```

Each register returns a function that removes that handler. Payloads are fully typed (`Alarm`, `C8yEvent`, `Measurement`, `ManagedObject`, `Operation`; a delete gives `{ id }`).

## Devices (scope)

The device is always the first argument: `'*'` for all devices, or a device id. Some types only allow one or the other, and the types enforce it:

| Type / Action                          | `'*'` (All) | A Device Id  |
| -------------------------------------- | ----------- | ------------ |
| `managedObjects.onCreate`              | ✓ (only)    | ✗            |
| `managedObjects.onUpdate` / `onDelete` | ✗           | ✓ (required) |
| `measurements.*`                       | ✗           | ✓ (required) |
| `alarms` / `events` / `operations` .*  | ✓           | ✓            |

`onAny` is the exception: its device argument is optional (`rt.onAny(fn)` = all).

## Type filters

Pass `{ source, type }` instead of a bare device to receive only some message types. `type` is one type string or a list. The platform filters server-side (Notification 2.0 `typeFilter`), so the rest never reaches your process.

```ts
rt.alarms.onCreate({ source: '*', type: 'c8y_TemperatureAlarm' }, (alarm) => {
  console.log(alarm.type) // 'c8y_TemperatureAlarm' — narrowed to what you asked for
})
rt.events.onCreate({ source: '12345', type: ['c8y_Boot', 'c8y_Shutdown'] }, (ev) => {
  console.log(ev.type) // 'c8y_Boot' | 'c8y_Shutdown'
})

// Key form: the types as a 4th segment, several separated by `|`
rt.hook('events:create:12345:c8y_Boot|c8y_Shutdown', handler)
```

In a key, everything after the third `:` is the filter, so a type containing `:` needs no escaping. Only two characters are ever encoded: a literal `|` is `%7C` and a literal `%` is `%25` (percent escapes on purpose: a backslash would silently vanish inside a JS string literal). The object form needs no escaping at all. `hookKeys()` returns the same canonical spelling (types sorted, duplicates removed), so a key you write and a key you get back always agree.

Pass your own object type as the generic to type the fragments. Its `type` literal must match the filter, or it's a compile error; the handler gets the base payload (`Alarm`, …) intersected with yours.

```ts
interface TempAlarm { type: 'c8y_TemperatureAlarm', c8y_Temperature: { T: { value: number } } }
interface DoorAlarm { type: 'c8y_DoorAlarm', c8y_Door: { open: boolean } }

rt.alarms.onCreate<TempAlarm>({ source: '*', type: 'c8y_TemperatureAlarm' }, (alarm) => {
  console.log(alarm.c8y_Temperature.T.value) // number; alarm.severity etc. still there
})
rt.alarms.onCreate<TempAlarm | DoorAlarm>({ source: '*', type: ['c8y_TemperatureAlarm', 'c8y_DoorAlarm'] }, (alarm) => {
  if (alarm.type === 'c8y_DoorAlarm')
    console.log(alarm.c8y_Door.open) // discriminated by `type`
})

rt.alarms.onCreate<TempAlarm>({ source: '*', type: 'c8y_DoorAlarm' }, handler) // ✗ type error
rt.alarms.onCreate<TempAlarm>('*', handler) // ✗ a generic needs a filtered scope
```

The generic's `type` should be a literal (or a union of literals). With `type: string` nothing can be checked and the payload's `type` stays `string`.

Available on `alarms`, `events`, `measurements` (the measurement `type`, not the series fragment), and `managedObjects`. Not on `operations` (no `type` field) or the global `rt.onAny`. `onDelete` and the per-type `onAny` take a filter too (the platform filters DELETEs by the deleted object's type), but their payload isn't narrowed, since a delete payload carries no `type`. The device rules above still apply.

**How it works, and what it costs.** Cumulocity can't update a subscription in place, and its uniqueness key is `(device, context, subscription name)` regardless of filter. So every distinct set of types gets its **own topic and consumer**, named `<name><Type>F<hash>` from the sorted types, and inside it everything works like the unfiltered case: one immutable subscription per device, handlers fire once. Consequences:

- One extra websocket per distinct type set. A filter you write once in code is one topic, reused across runs; building type sets from runtime input would create a topic per set.
- A filtered and an unfiltered registration on the same device are independent: cancelling one never touches the other, and a message matching both arrives on both (each to its own handlers).
- Removing, re-registering, `unsubscribe`, `detach`, `hookKeys()` work exactly as for unfiltered keys; the order of types in a key or list doesn't matter (`:b|a` ≡ `:a|b`).
- A frame on a filtered topic whose `type` is outside the set is dropped (and acked), so a handler typed for `c8y_X` never sees anything else.

## API

### `createRealtimeClient(options)`

Required: `name` (unique per app, alphanumeric), plus `baseUrl`, `tenant`, `user`, `password`.

| Option                       | Default | What It Does                                                                                                                                                          |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deleteSubscriptionOnEmpty`  | `true`  | Delete a device's remote subscription when its last handler is gone.                                                                                                  |
| `deleteSubscriptionsOnClose` | `false` | On `close()`, delete every subscription this client created (not ones it found already existing, which may belong to another process with the same `name`).           |
| `autoAck`                    | `true`  | Acknowledge each message after its handlers finish. Off: you call `n.ack()`. Frames the client drops itself (duplicates, no handler, out-of-filter) are always acked. |
| `autoStart`                  | `true`  | Connect as soon as handlers are registered.                                                                                                                           |
| `ensureSubscription`         | `true`  | Create the subscription on the platform if missing.                                                                                                                   |
| `dedupe`                     | `true`  | Drop identical messages redelivered on the same stream.                                                                                                               |
| `subscription`               | —       | `{ apis?, nonPersistent? }` (see [persistence](#persistence)).                                                                                                        |

Also accepts `resilience`, `logger`, `webSocketImpl`, `fetchImpl`.

### Registering handlers

Each returns an `Unsubscribe` function. Every register also takes an optional `label` (unique per client) so you can remove it later without keeping the returned function.

```ts
// `label` is optional in every register (see above).
rt.alarms.onCreate(scope, handler, label) // scope: '*' or a device id
rt.alarms.onCreate({ source: scope, type: 'c8y_X' }, handler, label) // + type filter
rt.measurements.onUpdate(deviceId, handler) // device id required
rt.managedObjects.onCreate('*', handler) // all devices only
rt.hook('alarms:create:12345', handler, label) // key = '<type>:<action>:<scope>[:<types>]'
rt.onAny(handler, label) // or rt.onAny(deviceId, handler)
```

### Removing handlers

```ts
const off = rt.alarms.onCreate('12345', handler)
off() // remove this one handler

rt.unhook('myLabel') // remove the one handler with that label
// → { removed, subscriptionDeleted }

rt.unsubscribe('alarms:create:12345')
// remove ALL handlers for the key; delete the remote subscription when empty
// → { removed, count, subscriptionDeleted }

rt.detach('alarms:create:12345')
// remove ALL handlers but KEEP the remote subscription (see below)
// → { removed, count, subscriptionDeleted: false }

rt.hasHook('alarms:create:12345') // → boolean
rt.hookKeys() // → ['alarms:create:12345', …]
```

`subscriptionDeleted` is `true` only when that removal left the device with no handlers _and_ the remote subscription was actually deleted. A key's handlers share one subscription with the other actions on the same device, so it isn't deleted while any of them remain.

### Control

`rt.start()` connects, `rt.close()` disconnects, `rt.subscriptions` is the REST API below.

### Replacing credentials after they run out

When a consumer's credentials run out (rotation) or are revoked (unsubscribe→resubscribe), it hits a fatal error and stops — `rt.healthy` flips to `false`. At that point `await rt.updateCredentials(creds)` gives the client fresh credentials **without losing handlers or remote subscriptions**: it validates the new creds, swaps the credential source, and reconnects only the stopped consumers. The `tenant` and `baseUrl` must stay the same — only the user/password may change.

This is repair-on-break, not proactive rotation. You may only call it while unhealthy:

- **`rt.healthy === true`** → `updateCredentials` **rejects and changes nothing**. A live client's sockets still hold valid tokens; there's nothing to repair, and swapping under them isn't allowed.
- **New creds don't authenticate** → **rejects and keeps the old creds** (they were valid at some point); the client stays unhealthy so you can retry with the next set.

```ts
if (!rt.healthy) {
  try {
    await rt.updateCredentials({ baseUrl, tenant, user, password: fresh })
    // repaired: stopped consumers reconnected, handlers intact
  } catch {
    // still healthy, or the new creds didn't authenticate — retry later
  }
}
```

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

- `client.subscriptions`: `list`, `get`, `create`, `ensure` (409 = already exists), `ensureDetailed` (same, plus `created: boolean`), `delete` (404 = already gone).
- `client.subscribe(name, options?)`: async-iterable consumer. Options: `subscriber`, `autoAck` (default `true`), `nonPersistent`, `shared`, `expiresInMinutes`, `consumerName`, `signal`. Set `autoAck: false` and call `n.ack()` yourself for at-least-once.
- `client.close()` closes every consumer.

</details>

## What's not included, and why

<details>
<summary>No <code>fragmentsToCopy</code> (payload trimming)</summary>

Every subscription forwards the full message. A trimmed and an untrimmed copy of the same message would look different to the duplicate suppression, and trimming is a per-subscription setting that can't be changed in place (see below). Type filtering is supported, see [Type filters](#type-filters).

</details>

<details>
<summary>No changing a live subscription</summary>

Cumulocity has no in-place update, only delete and recreate, which either drops messages (delete→create) or double-delivers (create→delete). So the client never edits a subscription after creating it: a type filter is part of the subscription's identity (its own topic), removing the last handler deletes it (see [lifecycle](#subscription-lifecycle)), and a new registration creates a fresh one.

</details>

<details>
<summary>No options object beyond <code>{ source, type }</code></summary>

Registers take a positional device (`'*'` or an id) or a `{ source, type }` scope, a handler, and an optional label. Both forms map to one string key (`'<type>:<action>:<scope>[:<types>]'`), so everything you register can be listed, checked, and removed by key.

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
