/**
 * High-level, ergonomic, strongly-typed realtime client for Cumulocity
 * Notification 2.0 — built on top of the framework-agnostic core
 * ({@link createNotificationClient}) and powered by `hookable`.
 *
 * Two registration surfaces, both fully typed:
 *
 * - Fluent namespaces:   `rt.alarms.onCreate({ id: '12345' }, (alarm) => …)`
 * - Hookable-style keys: `rt.hook({ key: 'alarms:create' }, (alarm) => …)`
 *
 * Every register takes an **options object** as its first argument (never a bare
 * string), so `{ … }` gets clean property completion for `id`/`key`,
 * `typeFilter`, and `fragmentsToCopy`.
 *
 * ## Scoping
 *
 * Each handler is scoped to a source (device) id or to all devices (`*`). The
 * scope drives a **real subscription**: registering `rt.alarms.onCreate({}, fn)`
 * opens a `tenant` subscription (all devices); `rt.alarms.onCreate({ id: '12345' }, fn)`
 * opens an `mo` subscription for that device. Each `(type, scope)` is its own
 * single-type subscription (never merged, never re-created); all subscriptions
 * of a type funnel into that type's topic, read by one consumer.
 *
 * The id is optional and defaults to `*` — **except** where Cumulocity has no
 * tenant-wide feed, which the types enforce:
 *
 * | type / action                | all-devices | specific id |
 * | ---------------------------- | ----------- | ----------- |
 * | managedobjects:create        | ✓           | ✗           |
 * | managedobjects:update/delete | ✗           | ✓ (required)|
 * | measurements:*               | ✗           | ✓ (required)|
 * | alarms/events/operations:*   | ✓           | ✓           |
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
 * Per-subscription filter/shaping options for a scope. These map to the
 * underlying subscription's `subscriptionFilter.typeFilter` and `fragmentsToCopy`
 * and are applied when the scope's subscription is first created.
 */
export interface ScopeFilter {
  /**
   * Match against the message `type` — pass the raw type name(s); they are
   * quoted and combined with OData `or` for you. A single name or an array:
   * `'c8y_Temperature'` → `"'c8y_Temperature'"`, and
   * `['c8y_Temperature', 'c8y_Pressure']` → `"'c8y_Temperature' or 'c8y_Pressure'"`.
   * When passed as a literal, the payload's `type` is narrowed to that union.
   */
  typeFilter?: string | readonly string[]
  /**
   * Restrict forwarded messages to these custom fragments. Base/known fields
   * (`id`, `source`, `type`, `time`, `self`, and type-specific ones like an
   * alarm's `severity`/`status`) are always kept; only non-listed *custom*
   * fragments are dropped. When passed as an array literal, the handler payload
   * is narrowed to the known fields + exactly these fragment keys (the
   * `[string]: unknown` catch-all is removed, so unlisted fragments are a
   * compile error).
   */
  fragmentsToCopy?: readonly string[]
}

/**
 * Drops the `[string]: unknown` index signature, keeping only explicit keys.
 */
type KnownKeys<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K]
}

/**
 * The union of type names from a `typeFilter` literal (string or array).
 */
type TypeUnion<T> = T extends readonly string[] ? T[number] : T

/**
 * Payload type when a scope uses `fragmentsToCopy`: the domain type's known
 * fields plus exactly the listed fragment names (each `unknown`), without the
 * catch-all index signature.
 */
export type FragmentPayload<P, F extends readonly string[]> = KnownKeys<P> & {
  [K in F[number]]: unknown
}

/**
 * Apply `fragmentsToCopy` narrowing (only when `F` is provided).
 */
type WithFragments<P, F extends readonly string[]> = [F] extends [never] ? P : FragmentPayload<P, F>

/**
 * The payload type a scoped registration receives, given the domain type `P`,
 * the `typeFilter` literal `T`, and the `fragmentsToCopy` literal `F`. Applies
 * fragment narrowing, then narrows `type` to the `typeFilter` union.
 */
export type ScopedPayload<P, T extends string | readonly string[], F extends readonly string[]>
  = string extends T
    ? WithFragments<P, F>
    : Omit<WithFragments<P, F>, 'type'> & { type: TypeUnion<T> }

/**
 * The typed options object for a scoped registration (drives {@link ScopedPayload}).
 */
interface ScopeOptions<T extends string | readonly string[], F extends readonly string[]> {
  typeFilter?: T
  fragmentsToCopy?: F
}

/**
 * `'*'` (all devices) or a specific source id. `(string & {})` keeps the `'*'`
 * literal visible for autocomplete while still accepting any id string.
 */
type SourceScope = '*' | (string & {})

/**
 * Register an all-devices handler. Always an options object (a single object
 * signature — no string/union — so `{ … }` gets clean property completion).
 * Use `{}` for all devices.
 */
export interface AllRegister<P> {
  <const T extends string | readonly string[] = string, const F extends readonly string[] = never>(
    options: ScopeOptions<T, F>,
    handler: NotificationHandler<ScopedPayload<P, T, F>>,
  ): Unsubscribe
}

/**
 * Register a device-scoped handler (source id required — no tenant-wide feed).
 * Always an options object with `id`.
 */
export interface IdRegister<P> {
  <const T extends string | readonly string[] = string, const F extends readonly string[] = never>(
    options: ScopeOptions<T, F> & { id: string },
    handler: NotificationHandler<ScopedPayload<P, T, F>>,
  ): Unsubscribe
}

/**
 * Register a handler for all devices or scoped to a source id. Always an options
 * object: `{}` (or `{ id: '*' }`) for all devices, `{ id }` for one.
 */
export interface AnyRegister<P> {
  <const T extends string | readonly string[] = string, const F extends readonly string[] = never>(
    options: ScopeOptions<T, F> & { id?: SourceScope },
    handler: NotificationHandler<ScopedPayload<P, T, F>>,
  ): Unsubscribe
}

/**
 * Back-compat alias for {@link AnyRegister}.
 */
export type ScopedRegister<P> = AnyRegister<P>

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
 * A typed hook key. The optional trailing `:sourceId` scopes to a device; it is
 * required for `measurements` and managed-object `update`/`delete`, and not
 * available for managed-object `create`.
 *
 * @example `'alarms:create'`, `'alarms:create:145075'`,
 * `'measurements:create:145075'`, `'managedobjects:update:145075'`
 */
export type RealtimeHookKey
  // all-devices (no id segment)
  = | `${DualScopeType}:${HookActionName}`
    | 'managedobjects:create'
  // device-scoped (id segment)
    | `${DualScopeType}:${HookActionName}:${string}`
    | `measurements:${HookActionName}:${string}`
    | `managedobjects:${'update' | 'delete'}:${string}`

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
   * Delete the subscription resources this client created when {@link
   * RealtimeClient.close} is called. Useful for ephemeral/test clients so they
   * leave nothing behind. Defaults to `false` (subscriptions are durable).
   */
  deleteSubscriptionsOnClose?: boolean
}

const WILDCARD = '*'
const DEDUPE_WINDOW = 2048

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
  readonly #deleteSubscriptionsOnClose: boolean

  // One single-type subscription resource per `${type}#${scope}` (created once,
  // never modified). `topicKey` is a notification type, or '*' for onAny.
  readonly #subs = new Map<string, Promise<void>>()
  readonly #ownedSubscriptionIds: string[] = []
  readonly #hookKeyCounts = new Map<string, number>()

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
    if (!options.name || !/^[a-z0-9]+$/i.test(options.name)) {
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
   * Register a typed handler using a `"<type>:<action>"` key, with the source id
   * optionally embedded as a third segment (`"<type>:<action>:<sourceId>"`). The
   * id is required for `measurements` and managed-object `update`/`delete`, and
   * unavailable for managed-object `create`. The payload type is inferred.
   *
   * Always an options object (a single object signature — no string/union — so
   * `{ … }` gets clean property completion for `key`, `typeFilter`,
   * `fragmentsToCopy`).
   *
   * @param options
   * @param handler
   * @example
   * ```ts
   * rt.hook({ key: 'alarms:create' }, (alarm) => {})              // all devices
   * rt.hook({ key: 'alarms:create:145075' }, (alarm) => {})       // only device 145075
   * rt.hook({ key: 'measurements:create:145075' }, (m) => {})     // id required
   * rt.hook({ key: 'managedobjects:delete:145075' }, ({ id }) => {})
   * ```
   */
  hook<K extends RealtimeHookKey, const T extends string | readonly string[] = string, const F extends readonly string[] = never>(
    options: ScopeOptions<T, F> & { key: K },
    handler: NotificationHandler<ScopedPayload<HookKeyPayload<K>, T, F>>,
  ): Unsubscribe {
    const { key } = options
    const filter: ScopeFilter = {
      typeFilter: options.typeFilter,
      fragmentsToCopy: options.fragmentsToCopy ? [...options.fragmentsToCopy] : undefined,
    }
    const [type = '', action = '', id] = key.split(':')
    const scope = id && id.length > 0 ? id : WILDCARD
    return this.#register(scope, type, action, handler as unknown as NotificationHandler<unknown>, filter)
  }

  /**
   * Register a handler for every notification, or for one device's feed.
   */
  onAny(handler: NotificationHandler<unknown>): Unsubscribe
  onAny(sourceId: string, handler: NotificationHandler<unknown>): Unsubscribe
  onAny(options: ScopeFilter & { id?: string }, handler: NotificationHandler<unknown>): Unsubscribe
  onAny(
    a: string | (ScopeFilter & { id?: string }) | NotificationHandler<unknown>,
    b?: NotificationHandler<unknown>,
  ): Unsubscribe {
    const { scope, filter, handler } = parseScopeArgs(a, b)
    return this.#register(scope, WILDCARD, WILDCARD, handler, filter)
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
    return ((a: unknown, b?: NotificationHandler<P>) => {
      const { scope, filter, handler } = parseScopeArgs(a, b as NotificationHandler<unknown> | undefined)
      return this.#register(scope, type, action, handler, filter)
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

  #register(scope: string, type: string, action: string, handler: NotificationHandler<unknown>, filter?: ScopeFilter): Unsubscribe {
    const hookKey = `${scope}#${type}:${action}`
    const wrapped = (payload: unknown, notification: Notification<unknown>): void | Promise<void> =>
      handler(payload, notification)
    const unhook = this.#hooks.hook(hookKey, wrapped as never)
    this.#hookKeyCounts.set(hookKey, (this.#hookKeyCounts.get(hookKey) ?? 0) + 1)

    // `type` is a notification type, or '*' for onAny — that is the topicKey.
    this.#topicKeys.add(type)
    this.#ensureSub(type, scope, filter)
    if (this.#autoStart)
      this.#ensureTopicConsumer(type)

    return () => {
      unhook()
      const remaining = (this.#hookKeyCounts.get(hookKey) ?? 1) - 1
      if (remaining <= 0)
        this.#hookKeyCounts.delete(hookKey)
      else
        this.#hookKeyCounts.set(hookKey, remaining)
    }
  }

  #topicName(topicKey: string): string {
    return topicKey === WILDCARD ? `${this.#base}All` : `${this.#base}${capitalize(topicKey)}`
  }

  /**
   * Ensure the single-type subscription for `(type, scope)` exists. Created once;
   * never modified (its apis are exactly `[type]`, or `['*']` for onAny). The
   * first registration's `filter` (typeFilter / fragmentsToCopy) is applied.
   * @param type
   * @param scope
   * @param filter
   */
  #ensureSub(type: string, scope: string, filter?: ScopeFilter): void {
    const key = `${type}#${scope}`
    if (this.#subs.has(key) || !this.#ensureSubscription)
      return
    const typeFilter = buildTypeFilter(filter?.typeFilter)
    const isTenant = scope === WILDCARD
    const subscription: Subscription = {
      context: isTenant ? 'tenant' : 'mo',
      subscription: this.#topicName(type),
      source: isTenant ? undefined : { id: scope },
      nonPersistent: this.#nonPersistent,
      subscriptionFilter: {
        apis: type === WILDCARD ? [...this.#apis] : [type as SubscriptionApi],
        ...(typeFilter ? { typeFilter } : {}),
      },
      ...(filter?.fragmentsToCopy?.length ? { fragmentsToCopy: [...filter.fragmentsToCopy] } : {}),
    }
    const promise = this.#client.subscriptions.ensure(subscription)
      .then((created) => {
        if (created.id)
          this.#ownedSubscriptionIds.push(created.id)
      })
      .catch((error) => {
        if (!this.#closing)
          this.#logger.error(`realtime: failed to ensure subscription ${key}`, error)
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
      if ((this.#hookKeyCounts.get(key) ?? 0) > 0)
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
 * Build a Notification 2.0 `typeFilter` from raw type name(s). Each name is
 * wrapped in single quotes (any internal quote doubled, per OData) and names are
 * combined with `or`: `['a', 'b']` → `'a' or 'b'`; `'a'` → `'a'`. Returns
 * `undefined` for an empty/absent filter.
 * @param typeFilter
 */
function buildTypeFilter(typeFilter: string | readonly string[] | undefined): string | undefined {
  if (typeFilter == null)
    return undefined
  const names = (Array.isArray(typeFilter) ? typeFilter : [typeFilter]).filter((name) => name.length > 0)
  if (names.length === 0)
    return undefined
  return names.map((name) => `'${name.replaceAll('\'', '\'\'')}'`).join(' or ')
}

/**
 * Normalize a registration's scope argument (a handler, a source-id string, or a
 * `{ id?, ...filter }` object) plus the trailing handler into `{ scope, filter,
 * handler }`.
 * @param a
 * @param b
 */
function parseScopeArgs(
  a: unknown,
  b: NotificationHandler<unknown> | undefined,
): { scope: string, filter: ScopeFilter | undefined, handler: NotificationHandler<unknown> } {
  if (typeof a === 'function')
    return { scope: WILDCARD, filter: undefined, handler: a as NotificationHandler<unknown> }
  if (!b)
    throw new TypeError('A notification handler function is required')
  if (typeof a === 'string')
    return { scope: a, filter: undefined, handler: b }
  const options = a as ScopeFilter & { id?: string }
  return {
    scope: options.id ?? WILDCARD,
    filter: { typeFilter: options.typeFilter, fragmentsToCopy: options.fragmentsToCopy },
    handler: b,
  }
}

/**
 * Create a high-level, typed realtime client.
 *
 * @param options
 * @example
 * ```ts
 * const rt = createRealtimeClient({ baseUrl, tenant, user, password })
 * rt.alarms.onCreate({}, (alarm) => console.log(alarm.severity))            // all devices
 * rt.measurements.onCreate({ id: '12345' }, (m) => console.log(m.type))     // one device
 * rt.hook({ key: 'managedobjects:update:12345' }, (mo) => console.log(mo.id))
 * ```
 */
export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  return new RealtimeClient(options)
}

/**
 * Re-exported for convenience so callers can type their own handlers.
 */
export type { NotificationPayloadMap }
