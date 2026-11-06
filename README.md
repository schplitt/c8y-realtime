# c8y-realtime

A small, typed TypeScript SDK for **Cumulocity Notification 2.0** realtime streams.

- Typed handlers per type, action, and device: `rt.alarms.onCreate('12345', (a) => …)`.
- Native `fetch` and the runtime's global `WebSocket`. No `@c8y/client`, no `ws`.
- Token, connection, keep-alive, reconnect, and de-duplication are handled for you.
- ESM only, strict TypeScript, Node ≥ 22 (or any runtime with a global `WebSocket`).

Two layers: the **high-level client** (`createRealtimeClient`, typed hooks, start here) and the **low-level core** (`createNotificationClient`, subscriptions REST + a raw consumer).

## Install

```sh
pnpm add c8y-realtime
```

On a runtime without a global `WebSocket`, or to use a specific one, pass `webSocketImpl` (e.g. `import { WebSocket } from 'ws'`).

## Quick start

```ts
import { createRealtimeClient } from 'c8y-realtime'

const rt = createRealtimeClient({ name: 'myApp', baseUrl, tenant, user, password }) // name: unique per app, alphanumeric

rt.alarms.onCreate('*', (alarm) => console.log(alarm.severity)) // all devices
rt.measurements.onCreate('12345', (m) => console.log(m.type)) // one device
rt.alarms.onCreate({ source: '*', type: 'c8y_TemperatureAlarm' }, (a) => console.log(a.text)) // one type (server-side filter)
rt.hook('alarms:create:*', (alarm) => console.log(alarm.text)) // same thing as a key
rt.onAny((payload, n) => console.log(n.description.type, n.action)) // everything

await rt.close()
```

Each register returns a function that removes that handler. Payloads are typed (`Alarm`, `C8yEvent`, `Measurement`, `ManagedObject`, `Operation`; a delete gives `{ id }`).

## Devices (scope)

The first argument is the device: `'*'` for all, or a device id. The types enforce what Cumulocity allows:

| Type / Action                          | `'*'`    | Device Id    |
| -------------------------------------- | -------- | ------------ |
| `managedObjects.onCreate`              | ✓ (only) | ✗            |
| `managedObjects.onUpdate` / `onDelete` | ✗        | ✓ (required) |
| `measurements.*`                       | ✗        | ✓ (required) |
| `alarms` / `events` / `operations` .*  | ✓        | ✓            |

`onAny` is the exception: its device is optional (`rt.onAny(fn)` = all).

## Type filters

Pass `{ source, type }` instead of a bare device to receive only some message types (one string or a list). The platform filters server-side, so the rest never reaches your process.

```ts
rt.events.onCreate({ source: '12345', type: ['c8y_Boot', 'c8y_Shutdown'] }, (ev) => console.log(ev.type)) // 'c8y_Boot' | 'c8y_Shutdown'
rt.hook('events:create:12345:c8y_Boot|c8y_Shutdown', handler) // key form: 4th segment, `|` between types
```

Pass your own object type as the generic to type the fragments. Its `type` literal (or union) must match the filter, or it's a compile error; the handler gets the base payload intersected with yours.

```ts
interface TempAlarm { type: 'c8y_TemperatureAlarm', c8y_Temperature: { T: { value: number } } }

rt.alarms.onCreate<TempAlarm>({ source: '*', type: 'c8y_TemperatureAlarm' }, (a) => console.log(a.c8y_Temperature.T.value, a.severity))
rt.alarms.onCreate<TempAlarm>({ source: '*', type: 'c8y_Other' }, handler) // ✗ type error
rt.alarms.onCreate<TempAlarm>('*', handler) // ✗ a generic needs a filtered scope
```

- Available on `alarms`, `events`, `measurements` (the measurement `type`, not the series fragment), and `managedObjects`. Not on `operations` (no `type`) or the global `rt.onAny`. `onDelete` and the per-type `onAny` take a filter but don't narrow the payload (a delete carries no `type`). The device rules above still apply.
- Keys: everything after the third `:` is the filter, so a `:` in a type needs no escaping. Only `|` (`%7C`) and `%` (`%25`) are encoded; not backslashes, which vanish silently inside JS string literals. The object form needs no escaping. `hookKeys()` returns the canonical spelling (sorted, deduped), so `:b|a` ≡ `:a|b`.
- A frame on a filtered topic whose `type` is outside the set is dropped and acked, so a handler typed for `c8y_X` never sees anything else.

**Cost.** Cumulocity can't update a subscription in place, and its uniqueness key ignores the filter. So every distinct set of types gets its **own topic and connection**, named `<name><Type>F<hash>`, inside which everything works like the unfiltered case. One extra websocket per distinct type set; a filter written in code is one topic, reused across runs, while type sets built from runtime input create a topic each. A filtered and an unfiltered registration on the same device are independent: cancelling one never touches the other, and a message matching both arrives on both.

## API

### `createRealtimeClient(options)`

Required: `name` (unique per app, alphanumeric), `baseUrl`, `tenant`, `user`, `password`. Also accepts `resilience`, `logger`, `webSocketImpl`, `fetchImpl`.

| Option                       | Default | What It Does                                                                                                                                                  |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deleteSubscriptionOnEmpty`  | `true`  | Delete a device's remote subscription when its last handler is gone.                                                                                          |
| `deleteSubscriptionsOnClose` | `false` | On `close()`, delete every subscription this client created (not ones it found already existing, which may belong to another process with the same `name`).   |
| `autoAck`                    | `true`  | Ack each message after its handlers finish. Off: you call `n.ack()`. Frames the client drops itself (duplicates, no handler, out-of-filter) are always acked. |
| `autoStart`                  | `true`  | Connect as soon as handlers are registered.                                                                                                                   |
| `ensureSubscription`         | `true`  | Create the subscription on the platform if missing.                                                                                                           |
| `dedupe`                     | `true`  | Drop identical messages redelivered on the same stream.                                                                                                       |
| `subscription`               | —       | `{ apis?, nonPersistent? }` (see [persistence](#persistence)).                                                                                                |

### Registering and removing handlers

Every register takes an optional `label` (unique per client) and returns an `Unsubscribe` function.

```ts
const off = rt.alarms.onCreate(scope, handler, label) // scope: '*', a device id, or { source, type }
rt.hook('alarms:create:12345', handler, label) // key = '<type>:<action>:<scope>[:<types>]'
rt.onAny(handler, label) // or rt.onAny(deviceId, handler)

off() // remove this one handler
rt.unhook('myLabel') // → { removed, subscriptionDeleted }
rt.unsubscribe('alarms:create:12345') // all handlers for the key; deletes the remote subscription when empty → { removed, count, subscriptionDeleted }
rt.detach('alarms:create:12345') // all handlers for the key; KEEPS the remote subscription → { …, subscriptionDeleted: false }
rt.hasHook('alarms:create:12345') // → boolean
rt.hookKeys() // → ['alarms:create:12345', …]
```

`subscriptionDeleted` is `true` only when that removal left the device with no handlers and the remote subscription was deleted. All actions of a device share one subscription, so it stays while any of them has a handler.

`rt.start()` connects, `rt.close()` disconnects, `rt.subscriptions` is the REST API below.

### Replacing credentials after they run out

When a consumer's credentials run out or are revoked, it stops and `rt.healthy` flips to `false`. Then `await rt.updateCredentials(creds)` validates the new credentials, swaps them in, and reconnects only the stopped consumers, keeping handlers and remote subscriptions. Same `tenant` and `baseUrl`; only user/password may change. It is repair-on-break, not proactive rotation:

- `rt.healthy === true` → rejects and changes nothing (live sockets already hold valid tokens).
- New creds don't authenticate → rejects and keeps the old ones; the client stays unhealthy so you can retry.

```ts
if (!rt.healthy)
  await rt.updateCredentials({ baseUrl, tenant, user, password: fresh }).catch(() => { /* retry later */ })
```

## Subscription lifecycle

One subscription per `(type, device)` lives as long as it has a handler. When the last one goes: `deleteSubscriptionOnEmpty: true` (default) deletes it and closes the type's connection once its last device is gone; `false` keeps it. `unsubscribe(key)` always deletes, `detach(key)` always keeps.

Keep a subscription only if you plan to resume it; re-registering then reuses it. A kept subscription with no handlers still counts against your quota, and with `autoAck` off its backlog grows unacknowledged.

## Persistence

`nonPersistent` is a Cumulocity delivery mode the SDK forwards onto both the subscription and the token.

- **Persistent** (default): Cumulocity keeps a durable per-consumer queue. After a disconnect you resume from your last ack and drain the backlog, so nothing is missed within the platform's TTL/quota. This is what makes the ack meaningful.
- **Non-persistent** (`subscription: { nonPersistent: true }`): no server-side queue; messages sent while disconnected are lost. Cheaper, and a fit for high-rate "current value only" feeds.

<details>
<summary>Low-level core — <code>createNotificationClient</code></summary>

```ts
import { createNotificationClient, SubscriptionApis } from 'c8y-realtime'

const client = createNotificationClient({ baseUrl, tenant, user, password })
await client.subscriptions.ensure({ context: 'tenant', subscription: 'myDemo', subscriptionFilter: { apis: [SubscriptionApis.measurements] } })

for await (const n of client.subscribe('myDemo', { subscriber: 'myService' })) {
  console.log(n.action, n.description.type, n.description.sourceId, n.payload)
  break // leaving the loop acks the last item and closes the consumer
}
await client.close()
```

- `client.subscriptions`: `list`, `get`, `create`, `ensure` (409 = already exists), `ensureDetailed` (same, plus `created: boolean`), `delete` (404 = already gone). Names must be alphanumeric.
- `client.subscribe(name, options?)`: async-iterable consumer. Options: `subscriber`, `autoAck` (default `true`), `nonPersistent`, `shared`, `expiresInMinutes`, `consumerName`, `signal`. Set `autoAck: false` and call `n.ack()` yourself for at-least-once.
- `client.close()` closes every consumer.

</details>

## What's not included, and why

- **No `fragmentsToCopy` (payload trimming).** A trimmed and an untrimmed copy of one message would defeat duplicate suppression, and trimming is a per-subscription setting that can't be changed in place.
- **No changing a live subscription.** Cumulocity has no in-place update, only delete + recreate, which either drops messages or double-delivers. A type filter is therefore part of a subscription's identity (its own topic); removing the last handler deletes it, and a new registration creates a fresh one.
- **No options object beyond `{ source, type }`.** Both scope forms map to one string key, so everything you register can be listed, checked, and removed by key.
- **Scoped `onAny` can't be removed by key.** `rt.onAny(fn)` has the key `'*'`. A scoped firehose (`rt.onAny(deviceId, fn)`) or a per-type one (`rt.alarms.onAny(…)`) spans all actions and has no key; remove those with the returned function or by `label`.
- **Handlers on the same key run one after another**, in registration order, each awaited before the next.

## Development

```sh
pnpm install && pnpm typecheck && pnpm lint && pnpm build
pnpm test:run # unit tests; the live tests in tests/e2e run only with a gitignored .env of throwaway credentials
```

## License

MIT
