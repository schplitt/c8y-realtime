/**
 * High-level, ergonomic, strongly-typed realtime client for Cumulocity
 * Notification 2.0 — built on top of the framework-agnostic core
 * ({@link createNotificationClient}) and powered by `hookable`.
 *
 * Two registration surfaces, both fully typed and both taking an **explicit
 * scope + a handler** (+ an optional unique label) — no options object. The
 * scope is always required: pass `'*'` for all devices or a source id for one.
 *
 * - Fluent namespaces:   `rt.alarms.onCreate('*', (alarm) => …)` / `rt.alarms.onCreate('12345', (alarm) => …)`
 * - Hookable-style keys: `rt.hook('alarms:create:*', (alarm) => …)`
 *
 * ## Scoping
 *
 * Each handler is scoped to a source (device) id or to all devices (`*`). The
 * scope drives a **real subscription**: registering `rt.alarms.onCreate('*', fn)`
 * opens a `tenant` subscription (all devices); `rt.alarms.onCreate('12345', fn)`
 * opens an `mo` subscription for that device. Each `(type, scope)` is its own
 * single-type subscription (never merged, never re-created); all subscriptions
 * of a type funnel into that type's topic, read by one consumer.
 *
 * The scope segment is always present — **except** where Cumulocity constrains
 * it, which the types enforce:
 *
 * | type / action                | all-devices (`'*'`) | specific id |
 * | ---------------------------- | ------------------- | ----------- |
 * | managedobjects:create        | ✓ (must be `'*'`)   | ✗           |
 * | managedobjects:update/delete | ✗                   | ✓ (required)|
 * | measurements:*               | ✗                   | ✓ (required)|
 * | alarms/events/operations:*   | ✓                   | ✓           |
 *
 * ## Lifecycle
 *
 * A `(type, scope)` subscription lives as long as it has at least one registered
 * handler (across all of its actions). With `deleteSubscriptionOnEmpty` (default
 * `true`), removing the **last** handler for a `(type, scope)` deletes its remote
 * subscription and — once a whole type has no scopes left — closes that type's
 * consumer. Use {@link RealtimeClient.detach} to remove handlers while keeping
 * the remote subscription alive for a later resume.
 *
 * ## No server-side or client-side filtering
 *
 * Subscriptions always forward the **full** message for their type — there is no
 * `typeFilter` and no `fragmentsToCopy`. Cumulocity Notification 2.0 has no
 * atomic *update* on a subscription (only delete + create), so a per-scope filter
 * could only be changed by unsubscribe→resubscribe (risking lost messages) or
 * subscribe→unsubscribe (risking double delivery). Forwarding everything keeps the
 * subscription immutable and lets any number of handlers share one `(type, scope)`
 * stream without conflict. Filter/shape inside your handler if you need to.
 */
import { createHooks } from 'hookable'
import { createNotificationClient } from './client'
import type { NotificationClient } from './client'
import type {
  Alarm,
  C8yEvent,
  DeletionPayload,
  HookActionName,
  HookPayload,
  ManagedObject,
  Measurement,
  NotificationPayloadMap,
  NotificationTypeName,
  Operation,
} from './domain'
import type { SubscriptionsApi } from './subscriptions'
import type {
  Logger,
  Notification,
  NotificationClientOptions,
  Subscription,
  SubscriptionApi,
} from './types'

/**
 * A typed notification handler.
 */
export type NotificationHandler<P> = (payload: P, notification: Notification<P>) => void | Promise<void>

/**
 * Unregisters a previously registered handler.
 */
export type Unsubscribe = () => void

/**
 * The outcome of {@link RealtimeClient.unsubscribe} / {@link RealtimeClient.detach}:
 * whether anything was removed and how many handlers (multiple handlers can
 * share one key).
 */
export interface UnsubscribeResult {
  /**
   * `true` when at least one handler was removed (i.e. the key had handlers).
   */
  removed: boolean
  /**
   * How many handlers were removed. `0` means the key had none registered.
   */
  count: number
  /**
   * `true` if removing these handlers emptied the `(type, scope)` and its remote
   * subscription was torn down (and the type's consumer closed if it was that
   * type's last scope). Always `false` for {@link RealtimeClient.detach}.
   */
  subscriptionDeleted: boolean
}

/**
 * The outcome of {@link RealtimeClient.unhook} (single handler by label).
 */
export interface UnhookResult {
  /**
   * `true` if a handler with that label existed and was removed; `false` if no
   * such label was registered on this client.
   */
  removed: boolean
  /**
   * `true` if that was the last handler for its `(type, scope)` and the remote
   * subscription was torn down (subject to `deleteSubscriptionOnEmpty`).
   */
  subscriptionDeleted: boolean
}

/**
 * `'*'` (all devices) or a specific source id. `(string & {})` keeps the `'*'`
 * literal visible for autocomplete while still accepting any id string.
 */
type SourceScope = '*' | (string & {})

/**
 * Register an all-devices handler. The scope is **required** and must be the
 * literal `'*'` — this action only exists tenant-wide (e.g. managed-object
 * `create`), so there is no device-id form. An optional unique `label` lets you
 * remove this exact handler later via {@link RealtimeClient.unhook}.
 */
export interface AllRegister<P> {
  (scope: '*', handler: NotificationHandler<P>, label?: string): Unsubscribe
}

/**
 * Register a device-scoped handler — the source id is **required** (this type has
 * no tenant-wide feed, e.g. `measurements` or managed-object `update`/`delete`).
 * An optional unique `label` enables {@link RealtimeClient.unhook}.
 */
export interface IdRegister<P> {
  (sourceId: string, handler: NotificationHandler<P>, label?: string): Unsubscribe
}

/**
 * Register a handler for all devices (`'*'`) or one source id — the scope is
 * **required** as the first argument. An optional unique `label` enables
 * {@link RealtimeClient.unhook}.
 */
export interface AnyRegister<P> {
  (scope: SourceScope, handler: NotificationHandler<P>, label?: string): Unsubscribe
}

/**
 * Alarm / event / operation namespace — every action supports all or a device.
 */
export interface TypeHooks<P> {
  /**
   * CREATE notifications (all devices, or a source id).
   */
  onCreate: AnyRegister<P>
  /**
   * UPDATE notifications (all devices, or a source id).
   */
  onUpdate: AnyRegister<P>
  /**
   * DELETE notifications (payload is `{ id }`).
   */
  onDelete: AnyRegister<DeletionPayload>
  /**
   * Any action for this type.
   */
  onAny: AnyRegister<P | DeletionPayload>
}

/**
 * Measurement namespace — device-scoped only (no tenant-wide measurement feed).
 */
export interface MeasurementHooks {
  onCreate: IdRegister<Measurement>
  onUpdate: IdRegister<Measurement>
  onDelete: IdRegister<DeletionPayload>
  onAny: IdRegister<Measurement | DeletionPayload>
}

/**
 * Managed-object namespace. CREATE is all-devices only (a new object has no id
 * yet); UPDATE and DELETE are device-scoped only (no tenant-wide feed).
 */
export interface ManagedObjectHooks {
  onCreate: AllRegister<ManagedObject>
  onUpdate: IdRegister<ManagedObject>
  onDelete: IdRegister<DeletionPayload>
}

/**
 * Types that have both a tenant-wide and a per-device feed.
 */
type DualScopeType = 'alarms' | 'events' | 'operations'

/**
 * A typed hook key `"<type>:<action>:<scope>"`. The scope segment is **always
 * required**: `'*'` for all devices, or a source id. For `measurements` and
 * managed-object `update`/`delete` it must be a device id (no tenant-wide feed);
 * for managed-object `create` it must be `'*'` (all-devices only).
 *
 * The lone key `'*'` is the `onAny` firehose (every type, every action, all
 * devices) — the key form of {@link RealtimeClient.onAny}.
 *
 * @example `'*'`, `'alarms:create:*'`, `'alarms:create:145075'`,
 * `'measurements:create:145075'`, `'managedobjects:update:145075'`
 */
export type RealtimeHookKey
  // '<type>:<action>:<scope>' — scope is always present: '*' for all devices, or a source id
  = | `${DualScopeType}:${HookActionName}:${string}`
    | `measurements:${HookActionName}:${string}`
    | 'managedobjects:create:*'
    | `managedobjects:${'update' | 'delete'}:${string}`
    // the onAny firehose: every type, every action, all devices
    | '*'

type ResolveHookPayload<T, A>
  = T extends NotificationTypeName
    ? A extends HookActionName
      ? HookPayload<T, A>
      : unknown
    : unknown

/**
 * The payload type inferred from a {@link RealtimeHookKey}.
 */
export type HookKeyPayload<K extends string>
  = K extends `${infer T}:${infer A}:${string}`
    ? ResolveHookPayload<T, A>
    : K extends `${infer T}:${infer A}`
      ? ResolveHookPayload<T, A>
      : unknown

/**
 * Options for the auto-managed subscriptions.
 */
export interface RealtimeSubscriptionOptions {
  /**
   * APIs for the `onAny` firehose topic. Typed topics always use just their own
   * type. Defaults to `['*']`.
   */
  apis?: SubscriptionApi[]
  /**
   * Target a non-persistent topic. Defaults to `false`.
   */
  nonPersistent?: boolean
}

/**
 * Options for {@link createRealtimeClient}.
 */
export interface RealtimeClientOptions extends NotificationClientOptions {
  /**
   * **Required.** Base name (alphanumeric) for this client's per-type topics and
   * consumers, yielding topics like `<name>Alarms`, `<name>Measurements`, and
   * `<name>All` (for `onAny`).
   *
   * Give **each distinct application a unique name**. The name identifies the
   * shared topic and consumer on the platform, so two independently-deployed
   * apps that reuse the same name become **competing consumers** on one stream —
   * each would receive only a fraction of the notifications. A per-app name
   * keeps every app's delivery independent and complete.
   */
  name: string
  /**
   * Subscription defaults (firehose APIs, persistence).
   */
  subscription?: RealtimeSubscriptionOptions
  /**
   * Acknowledge each notification after all handlers resolve. Defaults to `true`.
   */
  autoAck?: boolean
  /**
   * Ensure each subscription exists on start. Defaults to `true`.
   */
  ensureSubscription?: boolean
  /**
   * Open the connection automatically as handlers are registered. Defaults to `true`.
   */
  autoStart?: boolean
  /**
   * Drop duplicate notifications delivered more than once on the same topic
   * (e.g. on reconnect). Suppression is keyed by full frame content, so distinct
   * events are never dropped. Defaults to `true`.
   */
  dedupe?: boolean
  /**
   * When the **last** handler for a `(type, scope)` is removed (via a handler's
   * `Unsubscribe`, {@link RealtimeClient.unhook}, or {@link RealtimeClient.unsubscribe}),
   * delete that scope's remote subscription and — once a whole type has no scopes
   * left — close its consumer. Defaults to `true`.
   *
   * Set `false` to keep subscriptions durable (they survive having no handlers,
   * so re-registering resumes without a re-create and no persistent backlog is
   * lost). {@link RealtimeClient.unsubscribe} always deletes regardless; {@link
   * RealtimeClient.detach} always keeps regardless.
   */
  deleteSubscriptionOnEmpty?: boolean
  /**
   * Delete **every** subscription resource this client created when {@link
   * RealtimeClient.close} is called. Useful for ephemeral/test clients so they
   * leave nothing behind. Defaults to `false`.
   */
  deleteSubscriptionsOnClose?: boolean
}

const WILDCARD = '*'
const DEDUPE_WINDOW = 2048

/**
 * The Cumulocity alphanumeric subscription/subscriber-name rule: a `name` must
 * consist solely of ASCII letters and digits (`[a-z0-9]`, case-insensitive) and
 * be non-empty. This is the single source of truth used by the
 * {@link RealtimeClient} constructor; export it so downstream consumers can
 * validate/derive a `name` without hardcoding a divergent copy of the rule.
 */
export const REALTIME_NAME_REGEX = /^[a-z0-9]+$/i

/**
 * Turn an arbitrary string into a candidate realtime `name` by stripping every
 * character that is not `[a-z0-9]` (case-insensitive).
 *
 * Any **non-empty** result is guaranteed to satisfy {@link REALTIME_NAME_REGEX}.
 * This does **not** throw, does **not** add uniqueness, and **can return an
 * empty string** (e.g. an input made up entirely of separators like `'---'`).
 * The caller is responsible for handling/validating an empty result.
 *
 * @param raw
 * @returns the sanitized name, possibly empty
 */
export function toRealtimeName(raw: string): string {
  return raw.replace(/[^a-z0-9]/gi, '')
}

/**
 * One registered handler's bookkeeping. `subKey` (`${type}#${scope}`) identifies
 * the shared single-type subscription; `hookKey` (`${scope}#${type}:${action}`)
 * identifies the hookable bucket it fires from.
 */
interface HandlerEntry {
  hookKey: string
  subKey: string
  type: string
  scope: string
  label: string | undefined
  unhook: () => void
  removed: boolean
}

/**
 * The high-level realtime client. Prefer {@link createRealtimeClient} to
 * construct one.
 *
 * One topic + one consumer **per notification type** (plus one for `onAny`).
 * Each `(type, scope)` you register is its own single-type subscription — never
 * merged and never re-created — funneling into that type's topic; all
 * subscriptions of a type share one consumer, and notifications are routed to
 * handlers client-side by `sourceId`. This keeps deletes independent (removing
 * one handler never disturbs another) and bounds consumers to the number of
 * distinct types used, not the number of devices.
 *
 * Handlers registered under the same key fire **sequentially**, in registration
 * order, each awaited before the next — matching `hookable`'s serial `callHook`.
 */
export class RealtimeClient {
  /**
   * Inventory / managed object notifications.
   */
  readonly managedObjects: ManagedObjectHooks
  /**
   * Measurement notifications (device-scoped).
   */
  readonly measurements: MeasurementHooks
  /**
   * Event notifications.
   */
  readonly events: TypeHooks<C8yEvent>
  /**
   * Alarm notifications.
   */
  readonly alarms: TypeHooks<Alarm>
  /**
   * Operation notifications.
   */
  readonly operations: TypeHooks<Operation>

  readonly #client: NotificationClient
  readonly #hooks = createHooks()
  readonly #logger: Logger
  readonly #base: string
  readonly #apis: SubscriptionApi[]
  readonly #nonPersistent: boolean | undefined
  readonly #autoAck: boolean
  readonly #ensureSubscription: boolean
  readonly #autoStart: boolean
  readonly #dedupe: boolean
  readonly #deleteSubscriptionOnEmpty: boolean
  readonly #deleteSubscriptionsOnClose: boolean

  // One single-type subscription per `${type}#${scope}`; the value resolves to
  // its remote id (for deletion). `topicKey` is a notification type, or '*' for onAny.
  readonly #subs = new Map<string, Promise<string | undefined>>()
  // In-flight remote deletes per subKey. A re-subscribe waits for the pending
  // delete to finish before recreating, so delete and create never race.
  readonly #pendingDeletes = new Map<string, Promise<void>>()
  readonly #ownedSubscriptionIds: string[] = []
  // Per hookKey (`${scope}#${type}:${action}`), the live handler entries. The set
  // size drives dispatch ("is anyone listening?"), hasHook, and hookKeys.
  readonly #hookHandlers = new Map<string, Set<HandlerEntry>>()
  // Live handler count per subKey (`${type}#${scope}`), across all its actions —
  // drives delete-on-empty for the shared single-type subscription.
  readonly #subHandlerCount = new Map<string, number>()
  // Active scopes per type, for closing a type's consumer once its last scope goes.
  readonly #typeScopes = new Map<string, Set<string>>()
  // Unique-per-client handler labels → entry, for unhook(label).
  readonly #labels = new Map<string, HandlerEntry>()

  // One consumer per topicKey (per type + '*' for onAny).
  readonly #topicKeys = new Set<string>()
  readonly #topicStarted = new Set<string>()
  readonly #topicConsumers = new Map<string, () => Promise<void>>()

  // Per-topic bounded duplicate suppression (must be per-topic: the same event
  // legitimately arrives on both its type topic and the onAny topic).
  readonly #dedup = new Map<string, { seen: Set<string>, order: string[] }>()

  #closing = false

  constructor(options: RealtimeClientOptions) {
    this.#client = createNotificationClient(options)
    this.#logger = options.logger ?? { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    if (!options.name || !REALTIME_NAME_REGEX.test(options.name)) {
      throw new TypeError(
        `realtime: a unique alphanumeric \`name\` is required (got ${JSON.stringify(options.name)}). `
        + 'Give each application its own name so independently-deployed apps do not become competing consumers on the same topic.',
      )
    }
    const sub = options.subscription ?? {}
    this.#base = options.name
    this.#apis = sub.apis ?? ['*']
    this.#nonPersistent = sub.nonPersistent
    this.#autoAck = options.autoAck ?? true
    this.#ensureSubscription = options.ensureSubscription ?? true
    this.#autoStart = options.autoStart ?? true
    this.#dedupe = options.dedupe ?? true
    this.#deleteSubscriptionOnEmpty = options.deleteSubscriptionOnEmpty ?? true
    this.#deleteSubscriptionsOnClose = options.deleteSubscriptionsOnClose ?? false

    this.alarms = this.#dualNamespace<Alarm>('alarms')
    this.events = this.#dualNamespace<C8yEvent>('events')
    this.operations = this.#dualNamespace<Operation>('operations')
    this.measurements = {
      onCreate: this.#idReg<Measurement>('measurements', 'create'),
      onUpdate: this.#idReg<Measurement>('measurements', 'update'),
      onDelete: this.#idReg<DeletionPayload>('measurements', 'delete'),
      onAny: this.#idReg<Measurement | DeletionPayload>('measurements', WILDCARD),
    }
    this.managedObjects = {
      onCreate: this.#allReg<ManagedObject>('managedobjects', 'create'),
      onUpdate: this.#idReg<ManagedObject>('managedobjects', 'update'),
      onDelete: this.#idReg<DeletionPayload>('managedobjects', 'delete'),
    }
  }

  /**
   * REST access to the underlying subscriptions API.
   */
  get subscriptions(): SubscriptionsApi {
    return this.#client.subscriptions
  }

  /**
   * The subscription resource ids this client has created (for diagnostics).
   */
  get ownedSubscriptionIds(): readonly string[] {
    return this.#ownedSubscriptionIds
  }

  /**
   * Register a typed handler using a `"<type>:<action>:<scope>"` key. The scope
   * segment is **required**: `'*'` for all devices, or a source id (required for
   * `measurements` and managed-object `update`/`delete`; must be `'*'` for
   * managed-object `create`). The payload type is inferred from the key. An
   * optional unique `label` enables {@link unhook}.
   *
   * @param key
   * @param handler
   * @param label
   * @example
   * ```ts
   * rt.hook('alarms:create:*', (alarm) => {})            // all devices
   * rt.hook('alarms:create:145075', (alarm) => {})       // only device 145075
   * rt.hook('measurements:create:145075', (m) => {})     // id required
   * rt.hook('managedobjects:delete:145075', ({ id }) => {})
   * rt.hook('*', (payload, n) => {}) // firehose — same as rt.onAny(handler)
   * ```
   */
  hook<K extends RealtimeHookKey>(
    key: K,
    handler: NotificationHandler<HookKeyPayload<K>>,
    label?: string,
  ): Unsubscribe {
    if (key === WILDCARD)
      return this.#register(WILDCARD, WILDCARD, WILDCARD, handler as unknown as NotificationHandler<unknown>, label)
    const [type = '', action = '', id] = key.split(':')
    const scope = id && id.length > 0 ? id : WILDCARD
    return this.#register(scope, type, action, handler as unknown as NotificationHandler<unknown>, label)
  }

  /**
   * Register a handler for every notification, or for one device's feed. Unlike
   * the keyed registers, the scope here is **optional** — omit it for all
   * devices, or pass a source id for one. An optional unique `label` enables
   * {@link unhook}.
   *
   * The **all-devices** firehose (internal `*#*:*`) has the public key `'*'`, so
   * it is listed by {@link hookKeys} and removable via `unsubscribe('*')` /
   * `hasHook('*')` (or `rt.hook('*', handler)` to register). A **scoped** firehose
   * (`rt.onAny(sourceId, …)`, internal `<sourceId>#*:*`) has no key form — remove
   * it via the returned {@link Unsubscribe} or a `label`.
   * @param a
   * @param b
   * @param c
   */
  onAny(handler: NotificationHandler<unknown>, label?: string): Unsubscribe
  onAny(scope: SourceScope, handler: NotificationHandler<unknown>, label?: string): Unsubscribe
  onAny(
    a: string | NotificationHandler<unknown>,
    b?: string | NotificationHandler<unknown>,
    c?: string,
  ): Unsubscribe {
    const scope = typeof a === 'string' && a.length > 0 ? a : WILDCARD
    const handler = typeof a === 'function' ? a : b
    const label = typeof a === 'function' ? (typeof b === 'string' ? b : undefined) : c
    if (typeof handler !== 'function')
      throw new TypeError('A notification handler function is required')
    return this.#register(scope, WILDCARD, WILDCARD, handler, label)
  }

  /**
   * Remove **all** handlers registered under a hook key and report how many were
   * removed. The key uses the same grammar as {@link hook} —
   * `"<type>:<action>:<scope>"` (`'*'` = all devices).
   *
   * **Always** deletes the underlying single-type subscription once removing
   * these handlers leaves the `(type, scope)` with none (regardless of the
   * `deleteSubscriptionOnEmpty` option) — and closes the type's consumer if that
   * was its last scope. Note the subscription is shared across a `(type, scope)`'s
   * actions: `unsubscribe('alarms:create:*')` won't delete the remote while
   * `alarms:update:*` still has a handler. Use {@link detach} to remove handlers
   * but keep the subscription.
   *
   * @param key
   * @returns `{ removed, count }` — `removed` is `true` when at least one handler
   *   was removed; `count` is how many (`0` when the key had none registered).
   * @example
   * ```ts
   * rt.unsubscribe('alarms:create:145075') // → { removed: true, count: 2, subscriptionDeleted: true }
   * rt.unsubscribe('events:update:*')      // → { removed: false, count: 0, subscriptionDeleted: false }
   * ```
   */
  unsubscribe(key: RealtimeHookKey): UnsubscribeResult {
    return this.#removeAll(toHookKey(key), true)
  }

  /**
   * Remove **all** handlers registered under a hook key but **keep** the remote
   * subscription and its consumer alive (regardless of `deleteSubscriptionOnEmpty`),
   * so re-registering later resumes without re-creating the subscription.
   *
   * ⚠️ Use only when you intend to resume. A persistent subscription left with no
   * handlers still counts against your subscription quota, keeps being delivered
   * (and, with `autoAck`, dropped) — and if you disabled `autoAck`, its backlog
   * grows unacknowledged until TTL/quota. If you do **not** intend to resume, use
   * {@link unsubscribe} instead so nothing is left dangling.
   *
   * @param key
   * @returns `{ removed, count }` — same shape as {@link unsubscribe}.
   */
  detach(key: RealtimeHookKey): UnsubscribeResult {
    return this.#removeAll(toHookKey(key), false)
  }

  /**
   * Remove the single handler registered under `label` (labels are unique per
   * client — see the register `label` argument). Follows the
   * `deleteSubscriptionOnEmpty` policy if it was the last handler for its
   * `(type, scope)`.
   * @param label
   * @returns `{ removed, subscriptionDeleted }` — `removed` is `false` when no
   *   such label was registered; `subscriptionDeleted` is `true` when this was
   *   the last handler for its `(type, scope)` and the remote sub was removed.
   */
  unhook(label: string): UnhookResult {
    const entry = this.#labels.get(label)
    if (!entry || !this.#detachEntry(entry))
      return { removed: false, subscriptionDeleted: false }
    const subscriptionDeleted = this.#teardownIfEmpty(entry, this.#deleteSubscriptionOnEmpty)
    return { removed: true, subscriptionDeleted }
  }

  /**
   * Whether at least one handler is currently registered under a hook key (same
   * `"<type>:<action>:<scope>"` grammar as {@link hook}).
   * @param key
   */
  hasHook(key: RealtimeHookKey): boolean {
    return (this.#hookHandlers.get(toHookKey(key))?.size ?? 0) > 0
  }

  /**
   * List the keyed hooks that currently have at least one handler, in the public
   * `"<type>:<action>:<scope>"` form (`'*'` in the scope = all devices), plus the
   * lone `'*'` when an all-devices {@link onAny} firehose is registered. Every
   * entry is a valid {@link RealtimeHookKey} you can pass straight back to
   * {@link hasHook} / {@link unsubscribe}.
   *
   * The **scoped** `onAny` surfaces (`rt.onAny(sourceId, …)` and the per-type
   * `rt.<type>.onAny(…)`) have no valid key form, so they are **not** listed.
   * Manage those via the returned {@link Unsubscribe} or a `label`.
   *
   * @example `['*', 'alarms:create:*', 'alarms:create:145075', 'events:update:*']`
   */
  hookKeys(): RealtimeHookKey[] {
    const keys: RealtimeHookKey[] = []
    for (const hookKey of this.#hookHandlers.keys()) {
      if (isKeyedHook(hookKey))
        keys.push(toPublicKey(hookKey) as RealtimeHookKey)
    }
    return keys
  }

  /**
   * Ensure every registered subscription exists and every type's consumer is
   * connected. Idempotent; called automatically as handlers are registered
   * unless `autoStart` is `false`.
   */
  async start(): Promise<void> {
    await Promise.all([...this.#subs.values()])
    for (const topicKey of this.#topicKeys)
      this.#ensureTopicConsumer(topicKey)
  }

  /**
   * Stop consuming and release resources.
   */
  async close(): Promise<void> {
    this.#closing = true
    await Promise.all([...this.#topicConsumers.values()].map((close) => close()))
    if (this.#deleteSubscriptionsOnClose) {
      await Promise.all(this.#ownedSubscriptionIds.map((id) =>
        this.#client.subscriptions.delete(id).catch(() => {})))
    }
    await this.#client.close()
  }

  // ── namespaces ───────────────────────────────────────────────────────────

  #dualNamespace<P>(type: NotificationTypeName): TypeHooks<P> {
    return {
      onCreate: this.#anyReg<P>(type, 'create'),
      onUpdate: this.#anyReg<P>(type, 'update'),
      onDelete: this.#anyReg<DeletionPayload>(type, 'delete'),
      onAny: this.#anyReg<P | DeletionPayload>(type, WILDCARD),
    }
  }

  #reg<P, R>(type: string, action: string): R {
    return ((a: unknown, b?: NotificationHandler<P>, c?: string) => {
      const { scope, handler, label } = parseScopeArgs(a, b as NotificationHandler<unknown> | undefined, c)
      return this.#register(scope, type, action, handler, label)
    }) as R
  }

  #allReg<P>(type: string, action: string): AllRegister<P> {
    return this.#reg<P, AllRegister<P>>(type, action)
  }

  #idReg<P>(type: string, action: string): IdRegister<P> {
    return this.#reg<P, IdRegister<P>>(type, action)
  }

  #anyReg<P>(type: string, action: string): AnyRegister<P> {
    return this.#reg<P, AnyRegister<P>>(type, action)
  }

  // ── registration & dispatch ──────────────────────────────────────────────

  #register(scope: string, type: string, action: string, handler: NotificationHandler<unknown>, label?: string): Unsubscribe {
    if (label != null && this.#labels.has(label)) {
      throw new Error(
        `realtime: a hook labeled ${JSON.stringify(label)} is already registered on this client; labels must be unique.`,
      )
    }
    const hookKey = `${scope}#${type}:${action}`
    const subKey = `${type}#${scope}`
    const wrapped = (payload: unknown, notification: Notification<unknown>): void | Promise<void> =>
      handler(payload, notification)
    const unhook = this.#hooks.hook(hookKey, wrapped as never)
    const entry: HandlerEntry = { hookKey, subKey, type, scope, label, unhook, removed: false }

    let set = this.#hookHandlers.get(hookKey)
    if (!set) {
      set = new Set()
      this.#hookHandlers.set(hookKey, set)
    }
    set.add(entry)
    if (label != null)
      this.#labels.set(label, entry)
    this.#subHandlerCount.set(subKey, (this.#subHandlerCount.get(subKey) ?? 0) + 1)
    let scopes = this.#typeScopes.get(type)
    if (!scopes) {
      scopes = new Set()
      this.#typeScopes.set(type, scopes)
    }
    scopes.add(scope)

    // `type` is a notification type, or '*' for onAny — that is the topicKey.
    this.#topicKeys.add(type)
    this.#ensureSub(type, scope)
    if (this.#autoStart)
      this.#ensureTopicConsumer(type)

    // Idempotent: safe to call twice, or after unsubscribe/detach already removed
    // it — a second call is a no-op.
    return () => {
      if (this.#detachEntry(entry))
        this.#teardownIfEmpty(entry, this.#deleteSubscriptionOnEmpty)
    }
  }

  /**
   * Detach every handler under a hookKey. `deleteRemote` chooses the remote
   * policy: `true` (unsubscribe) deletes the subscription when the `(type,scope)`
   * empties; `false` (detach) keeps it.
   * @param hookKey
   * @param deleteRemote
   */
  #removeAll(hookKey: string, deleteRemote: boolean): UnsubscribeResult {
    const set = this.#hookHandlers.get(hookKey)
    if (!set || set.size === 0)
      return { removed: false, count: 0, subscriptionDeleted: false }
    const entries = [...set]
    let count = 0
    for (const entry of entries) {
      if (this.#detachEntry(entry))
        count += 1
    }
    const subscriptionDeleted = deleteRemote && entries[0] ? this.#teardownIfEmpty(entries[0], true) : false
    return { removed: count > 0, count, subscriptionDeleted }
  }

  /**
   * Remove one handler from hookable + all bookkeeping. Returns `true` if this
   * call removed it (idempotent — `false` if already removed).
   * @param entry
   */
  #detachEntry(entry: HandlerEntry): boolean {
    if (entry.removed)
      return false
    entry.removed = true
    entry.unhook()
    const set = this.#hookHandlers.get(entry.hookKey)
    set?.delete(entry)
    if (set && set.size === 0)
      this.#hookHandlers.delete(entry.hookKey)
    if (entry.label != null)
      this.#labels.delete(entry.label)
    const remaining = (this.#subHandlerCount.get(entry.subKey) ?? 1) - 1
    if (remaining <= 0)
      this.#subHandlerCount.delete(entry.subKey)
    else
      this.#subHandlerCount.set(entry.subKey, remaining)
    return true
  }

  /**
   * If a `(type, scope)` now has no handlers and `deleteRemote` is set, delete its
   * remote subscription and — if the type has no scopes left — close its consumer.
   * @param entry
   * @param deleteRemote
   */
  #teardownIfEmpty(entry: HandlerEntry, deleteRemote: boolean): boolean {
    if (!deleteRemote)
      return false
    if ((this.#subHandlerCount.get(entry.subKey) ?? 0) > 0)
      return false // another action for this (type, scope) still has a handler
    this.#deleteRemoteSub(entry.subKey)
    const scopes = this.#typeScopes.get(entry.type)
    if (scopes) {
      scopes.delete(entry.scope)
      if (scopes.size === 0) {
        this.#typeScopes.delete(entry.type)
        this.#closeConsumer(entry.type)
      }
    }
    return true
  }

  /**
   * Delete a `(type, scope)`'s remote subscription (best-effort, in the
   * background) and forget it so a later registration re-creates it.
   * @param subKey
   */
  #deleteRemoteSub(subKey: string): void {
    const idPromise = this.#subs.get(subKey)
    this.#subs.delete(subKey)
    if (!idPromise)
      return
    // Record the in-flight delete so a re-subscribe of the same `(type, scope)`
    // waits for it to finish before creating (see #ensureSub) — otherwise the
    // create could land first and this delete would then remove it, leaving the
    // client silently unsubscribed.
    const done: Promise<void> = Promise.resolve(idPromise)
      .then((id) => (id ? this.#client.subscriptions.delete(id).catch(() => {}) : undefined))
      .catch(() => {})
      .finally(() => {
        if (this.#pendingDeletes.get(subKey) === done)
          this.#pendingDeletes.delete(subKey)
      })
    this.#pendingDeletes.set(subKey, done)
  }

  /**
   * Close and forget a type's consumer so a later registration re-opens it.
   * @param topicKey
   */
  #closeConsumer(topicKey: string): void {
    const close = this.#topicConsumers.get(topicKey)
    this.#topicConsumers.delete(topicKey)
    this.#topicStarted.delete(topicKey)
    this.#topicKeys.delete(topicKey)
    this.#dedup.delete(topicKey)
    if (close)
      close().catch(() => {})
  }

  #topicName(topicKey: string): string {
    return topicKey === WILDCARD ? `${this.#base}All` : `${this.#base}${capitalize(topicKey)}`
  }

  /**
   * Ensure the single-type subscription for `(type, scope)` exists. Created once;
   * never modified. Its apis are exactly `[type]` (or `['*']` for onAny) and it
   * forwards the **full** message — no `typeFilter`, no `fragmentsToCopy`, so any
   * number of handlers can share one `(type, scope)` stream without conflict.
   * @param type
   * @param scope
   */
  #ensureSub(type: string, scope: string): void {
    const key = `${type}#${scope}`
    if (this.#subs.has(key) || !this.#ensureSubscription)
      return
    const isTenant = scope === WILDCARD
    const subscription: Subscription = {
      context: isTenant ? 'tenant' : 'mo',
      subscription: this.#topicName(type),
      source: isTenant ? undefined : { id: scope },
      nonPersistent: this.#nonPersistent,
      subscriptionFilter: {
        apis: type === WILDCARD ? [...this.#apis] : [type as SubscriptionApi],
      },
    }
    // If a delete for this `(type, scope)` is still in flight, wait for it to
    // finish before creating, so the create can't be undone by the late delete.
    const pending = this.#pendingDeletes.get(key)
    const promise = (pending ?? Promise.resolve())
      .then(() => this.#client.subscriptions.ensure(subscription))
      .then((created) => {
        if (created.id)
          this.#ownedSubscriptionIds.push(created.id)
        return created.id
      })
      .catch((error) => {
        if (!this.#closing)
          this.#logger.error(`realtime: failed to ensure subscription ${key}`, error)
        return undefined
      })
    this.#subs.set(key, promise)
  }

  /**
   * Ensure the single consumer for a type's topic is connected.
   * @param topicKey
   */
  #ensureTopicConsumer(topicKey: string): void {
    if (this.#topicStarted.has(topicKey))
      return
    this.#topicStarted.add(topicKey)
    const name = this.#topicName(topicKey)
    const consumer = this.#client.subscribe(name, {
      subscriber: `${name}Consumer`,
      autoAck: false,
      nonPersistent: this.#nonPersistent,
    })
    this.#topicConsumers.set(topicKey, () => consumer.close())
    this.#pump(topicKey, consumer).catch((error) => {
      if (!this.#closing)
        this.#logger.error(`realtime consumer pump failed for ${name}`, error)
    })
  }

  async #pump(topicKey: string, consumer: AsyncIterable<Notification>): Promise<void> {
    for await (const notification of consumer) {
      try {
        await this.#dispatch(topicKey, notification)
      } catch (error) {
        this.#logger.error('notification handler threw', error)
      }
    }
  }

  async #dispatch(topicKey: string, notification: Notification): Promise<void> {
    const type = notification.description.type
    const action = notification.action.toLowerCase()
    const source = notification.description.sourceId || WILDCARD

    if (this.#dedupe && this.#isDuplicate(topicKey, type, action, source, notification.rawPayload)) {
      if (this.#autoAck)
        notification.ack() // clear the duplicate from the backlog, but don't re-deliver
      return
    }

    // The onAny ('*') topic fires onAny handlers; a typed topic fires that type's handlers.
    const keys = topicKey === WILDCARD
      ? new Set<string>([
          `${source}#${WILDCARD}:${WILDCARD}`,
          `${WILDCARD}#${WILDCARD}:${WILDCARD}`,
        ])
      : new Set<string>([
          `${source}#${type}:${action}`,
          `${WILDCARD}#${type}:${action}`,
          `${source}#${type}:${WILDCARD}`,
          `${WILDCARD}#${type}:${WILDCARD}`,
        ])
    let handled = false
    for (const key of keys) {
      if ((this.#hookHandlers.get(key)?.size ?? 0) > 0)
        handled = true
      await this.#hooks.callHook(key, notification.payload, notification)
    }

    if (!handled)
      this.#logger.debug(`realtime: no handler for ${type}:${action} (source ${source}) — acknowledged and dropped`)

    if (this.#autoAck)
      notification.ack()
  }

  /**
   * Per-topic duplicate detection keyed by full frame content. Identical content
   * delivered twice on the SAME topic (reconnect) is a duplicate; genuinely
   * distinct events differ in their payload so are never suppressed.
   * @param topicKey
   * @param type
   * @param action
   * @param source
   * @param rawPayload
   */
  #isDuplicate(topicKey: string, type: string, action: string, source: string, rawPayload: string): boolean {
    let state = this.#dedup.get(topicKey)
    if (!state) {
      state = { seen: new Set(), order: [] }
      this.#dedup.set(topicKey, state)
    }
    const key = `${type}#${action}#${source}#${rawPayload}`
    if (state.seen.has(key))
      return true
    state.seen.add(key)
    state.order.push(key)
    if (state.order.length > DEDUPE_WINDOW)
      state.seen.delete(state.order.shift()!)
    return false
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

/**
 * Map a public hook key `"<type>:<action>:<scope>"` to the internal
 * `"<scope>#<type>:<action>"` form (an absent/empty scope ⇒ the `*` scope).
 * Mirrors the scope resolution in {@link RealtimeClient.hook}.
 * @param key
 */
function toHookKey(key: string): string {
  if (key === WILDCARD)
    return `${WILDCARD}#${WILDCARD}:${WILDCARD}`
  const [type = '', action = '', id] = key.split(':')
  const scope = id && id.length > 0 ? id : WILDCARD
  return `${scope}#${type}:${action}`
}

/**
 * Inverse of {@link toHookKey}: map an internal `"<scope>#<type>:<action>"` key
 * back to the public `"<type>:<action>:<scope>"` form (the scope segment is
 * always present, `'*'` for all devices).
 * @param hookKey
 */
function toPublicKey(hookKey: string): string {
  if (hookKey === `${WILDCARD}#${WILDCARD}:${WILDCARD}`)
    return WILDCARD
  const hash = hookKey.indexOf('#')
  const scope = hookKey.slice(0, hash)
  const typeAction = hookKey.slice(hash + 1)
  return `${typeAction}:${scope}`
}

/**
 * Whether an internal hookKey maps to a valid {@link RealtimeHookKey}. That's
 * either a concrete keyed registration (`hook()` / `onCreate`/`onUpdate`/
 * `onDelete`) or the global `onAny` firehose `*#*:*` (public key `'*'`). The
 * **scoped** `onAny` surfaces — a per-device firehose (`<id>#*:*`) or a per-type
 * `rt.<type>.onAny` (`*#<type>:*`) — have no key form and are excluded.
 * @param hookKey
 */
function isKeyedHook(hookKey: string): boolean {
  if (hookKey === `${WILDCARD}#${WILDCARD}:${WILDCARD}`)
    return true
  const [type = '', action = ''] = hookKey.slice(hookKey.indexOf('#') + 1).split(':')
  return type !== WILDCARD && action !== WILDCARD
}

/**
 * Normalize a namespace register's `(scope, handler, label?)` arguments. The
 * scope is required (a `'*'`/id string); an empty string is treated as the
 * all-devices `*` scope.
 * @param a
 * @param b
 * @param c
 */
function parseScopeArgs(
  a: unknown,
  b: NotificationHandler<unknown> | undefined,
  c: string | undefined,
): { scope: string, handler: NotificationHandler<unknown>, label: string | undefined } {
  if (typeof a !== 'string' || typeof b !== 'function')
    throw new TypeError('A source scope ("*" for all devices, or a device id) and a handler function are required')
  return { scope: a.length > 0 ? a : WILDCARD, handler: b, label: typeof c === 'string' ? c : undefined }
}

/**
 * Create a high-level, typed realtime client.
 *
 * @param options
 * @example
 * ```ts
 * const rt = createRealtimeClient({ name, baseUrl, tenant, user, password })
 * rt.alarms.onCreate('*', (alarm) => console.log(alarm.severity))      // all devices
 * rt.measurements.onCreate('12345', (m) => console.log(m.type))        // one device
 * rt.hook('managedobjects:update:12345', (mo) => console.log(mo.id))
 * ```
 */
export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  return new RealtimeClient(options)
}

/**
 * Re-exported for convenience so callers can type their own handlers.
 */
export type { NotificationPayloadMap }
