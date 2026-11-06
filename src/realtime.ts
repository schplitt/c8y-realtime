/**
 * High-level, ergonomic, strongly-typed realtime client for Cumulocity
 * Notification 2.0 — built on top of the framework-agnostic core
 * ({@link createNotificationClient}) and powered by `hookable`.
 *
 * Two registration surfaces, both fully typed and both taking an **explicit
 * scope + a handler** (+ an optional unique label). The scope is always
 * required: `'*'` for all devices, a source id for one, or `{ source, type }`
 * to add a type filter (see below).
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
 * ## Type filters: one topic per filter group
 *
 * A registration may narrow by the message `type` (Notification 2.0
 * `typeFilter`): `rt.alarms.onCreate({ source: '*', type: 'c8y_TemperatureAlarm' }, fn)`
 * or `rt.hook('alarms:create:*:c8y_TemperatureAlarm', fn)`. The platform's
 * subscription uniqueness key is `(source, context, subscription name)` and
 * ignores the filter, and a subscription can never be updated in place — so a
 * filter cannot ride on the unfiltered topic. Instead each distinct **filter
 * group** (the canonical, sorted set of types) gets its **own topic + consumer**,
 * named `<name><Type>F<hash>`. Inside a group everything works exactly like the
 * unfiltered case: one immutable single-type subscription per scope (carrying
 * `typeFilter`), routing by topic, handlers fire once by construction. An
 * unfiltered and a filtered registration on the same scope are two independent
 * topics; cancelling one never touches the other. The cost is one websocket per
 * filter group. There is still no `fragmentsToCopy`.
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
  TenantCredentials,
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
export type SourceScope = '*' | (string & {})

/**
 * A scope narrowed by message `type` (Notification 2.0 `typeFilter`). `source`
 * is the device scope exactly as in the string form (`'*'` or a source id);
 * `type` is one type string or a list (sent as the OData `'a' or 'b'` form).
 * Each distinct set of types is its own topic + consumer (see the module docs).
 */
export interface FilteredScope<S extends string = SourceScope, T extends string = string> {
  source: S
  type: T | readonly T[]
}

/**
 * The literal `type` a payload type carries, or `string` when unconstrained.
 * Exported for people writing typed wrappers around the filtered registers.
 */
export type PayloadType<P> = P extends { type: infer T } ? (T extends string ? T : string) : string

/**
 * A register taking a plain string scope: `(scope, handler, label?)`.
 */
export interface ScopedRegister<P, S extends string> {
  (scope: S, handler: NotificationHandler<P>, label?: string): Unsubscribe
}

/**
 * A register that additionally accepts a {@link FilteredScope}. Pass your own
 * object type (or a union) as the generic: its `type` literal(s) constrain the
 * filter — a mismatch is a compile error — and the handler receives the base
 * payload intersected with it:
 *
 * ```ts
 * interface TempAlarm { type: 'c8y_TemperatureAlarm', c8y_Temperature: { T: { value: number } } }
 * rt.alarms.onCreate<TempAlarm>({ source: '*', type: 'c8y_TemperatureAlarm' }, (a) => a.c8y_Temperature.T.value)
 * rt.alarms.onCreate<TempAlarm>({ source: '*', type: 'c8y_Other' }, fn) // ✗ type error
 * ```
 *
 * Without a generic the payload is the base type with `type` narrowed to the
 * literal(s) you passed.
 */
export interface FilterableRegister<P, S extends string> extends ScopedRegister<P, S> {
  <Q extends { type: string } = P & { type: string }, const T extends PayloadType<Q> = PayloadType<Q>>(
    scope: FilteredScope<S, T>,
    handler: NotificationHandler<P & Q & { type: T }>,
    label?: string,
  ): Unsubscribe
}

/**
 * Register an all-devices handler. The scope is **required** and must be the
 * literal `'*'` — this action only exists tenant-wide (e.g. managed-object
 * `create`), so there is no device-id form. An optional unique `label` lets you
 * remove this exact handler later via {@link RealtimeClient.unhook}.
 */
export type AllRegister<P> = ScopedRegister<P, '*'>

/**
 * Register a device-scoped handler — the source id is **required** (this type has
 * no tenant-wide feed, e.g. `measurements` or managed-object `update`/`delete`).
 * An optional unique `label` enables {@link RealtimeClient.unhook}.
 */
export type IdRegister<P> = ScopedRegister<P, string>

/**
 * Register a handler for all devices (`'*'`) or one source id — the scope is
 * **required** as the first argument. An optional unique `label` enables
 * {@link RealtimeClient.unhook}.
 */
export type AnyRegister<P> = ScopedRegister<P, SourceScope>

/**
 * Alarm / event / operation namespace — every action supports all or a device.
 * This is the plain (string-scope) shape; `alarms` and `events` expose the
 * {@link FilterableTypeHooks} subtype, which adds type filters (with payload
 * narrowing on `onCreate` / `onUpdate`, filter-only on `onDelete` / `onAny`).
 * `operations` stays plain (no `type` field).
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
 * A register that accepts a {@link FilteredScope} **without** payload
 * narrowing — for `onDelete` / `onAny`, where the payload (a DELETE's `{ id }`)
 * carries no `type` to narrow. The platform still filters server-side: a
 * filtered `onDelete` only sees deletes of matching types.
 */
export interface FilterOnlyRegister<P, S extends string> extends ScopedRegister<P, S> {
  (scope: FilteredScope<S>, handler: NotificationHandler<P>, label?: string): Unsubscribe
}

/**
 * {@link TypeHooks} whose registers also take a {@link FilteredScope} (type
 * filter): `onCreate` / `onUpdate` with payload narrowing, `onDelete` / `onAny`
 * without. Assignable to `TypeHooks<P>`, so generic code written against that
 * keeps working.
 */
export interface FilterableTypeHooks<P> extends TypeHooks<P> {
  onCreate: FilterableRegister<P, SourceScope>
  onUpdate: FilterableRegister<P, SourceScope>
  onDelete: FilterOnlyRegister<DeletionPayload, SourceScope>
  onAny: FilterOnlyRegister<P | DeletionPayload, SourceScope>
}

/**
 * Measurement namespace — device-scoped only (no tenant-wide measurement feed).
 */
export interface MeasurementHooks {
  onCreate: FilterableRegister<Measurement, string>
  onUpdate: FilterableRegister<Measurement, string>
  onDelete: FilterOnlyRegister<DeletionPayload, string>
  onAny: FilterOnlyRegister<Measurement | DeletionPayload, string>
}

/**
 * Managed-object namespace. CREATE is all-devices only (a new object has no id
 * yet); UPDATE and DELETE are device-scoped only (no tenant-wide feed).
 */
export interface ManagedObjectHooks {
  onCreate: FilterableRegister<ManagedObject, '*'>
  onUpdate: FilterableRegister<ManagedObject, string>
  onDelete: FilterOnlyRegister<DeletionPayload, string>
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
 * A `create` / `update` / `delete` key may carry a type filter as a **4th segment**,
 * several types separated by `|`: `'alarms:create:*:c8y_TemperatureAlarm'`,
 * `'events:create:145075:c8y_A|c8y_B'`. Everything after the third `:` is the
 * filter, so a type containing `:` needs no escaping; a literal `|` is written
 * `%7C` and a literal `%` is `%25` (nothing else is ever encoded — and unlike a
 * backslash, `%` survives a JS string literal untouched). Not valid on
 * `operations` (no `type`). On a `delete` key the platform still filters, but
 * the payload is not narrowed (a DELETE payload carries no `type`).
 *
 * The lone key `'*'` is the `onAny` firehose (every type, every action, all
 * devices) — the key form of {@link RealtimeClient.onAny}.
 *
 * @example `'*'`, `'alarms:create:*'`, `'alarms:create:145075'`,
 * `'measurements:create:145075'`, `'managedobjects:update:145075'`,
 * `'alarms:create:*:c8y_TemperatureAlarm'`, `'events:create:*:c8y_A|c8y_B'`
 */
export type RealtimeHookKey
  // '<type>:<action>:<scope>' — scope is always present: '*' for all devices, or a source id
  = | `${DualScopeType}:${HookActionName}:${string}`
    | `measurements:${HookActionName}:${string}`
    | 'managedobjects:create:*'
    | `managedobjects:create:*:${string}`
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
 * `'a|b|c'` → `'a' | 'b' | 'c'`.
 */
type SplitPipe<S extends string> = S extends `${infer Head}|${infer Rest}` ? Head | SplitPipe<Rest> : S

/**
 * The literal type(s) a key's 4th segment names (given the part after the 2nd
 * `:`), or `never` when there is no filter or it contains a `%` escape (then
 * `type` stays `string`).
 */
type KeyTypeFilter<S extends string>
  = S extends `${string}:${infer Ty}`
    ? Ty extends `${string}%${string}` ? never : SplitPipe<Ty>
    : never

/**
 * Validates a hook key's filter segment at the type level: the key itself when
 * valid, `never` for a filter on `operations` (no `type`) or an empty type in
 * the segment (`'…:*:'`, `'…:a||b'`, `'…:|a'`, `'…:a|'`). Exported for people
 * writing typed wrappers around {@link RealtimeClient.hook}.
 */
export type ValidHookKey<K extends string>
  = K extends
  | `operations:${string}:${string}:${string}`
  | `${string}:${string}:${string}:`
  | `${string}:${string}:${string}:${string}||${string}`
  | `${string}:${string}:${string}:|${string}`
  | `${string}:${string}:${string}:${string}|`
    ? never
    : K

/**
 * What an explicit payload generic on {@link RealtimeClient.hook} must satisfy:
 * for a key with a type filter, an object whose `type` is (one of) those
 * literal(s); otherwise unconstrained.
 */
export type HookKeyConstraint<K extends string>
  = K extends `${string}:delete:${string}`
    ? unknown
    : K extends `${string}:${string}:${infer S}`
      ? [KeyTypeFilter<S>] extends [never] ? unknown : { type: KeyTypeFilter<S> }
      : unknown

/**
 * The payload type inferred from a {@link RealtimeHookKey}. A type-filter
 * segment narrows the payload's `type` to that literal (or union).
 */
export type HookKeyPayload<K extends string>
  = K extends `${infer T}:${infer A}:${infer S}`
    ? [KeyTypeFilter<S>] extends [never] | [string] ? ResolveHookPayload<T, A> // no filter / escapes → no narrowing
        : A extends 'delete' ? ResolveHookPayload<T, A> // a DELETE payload has no `type` to narrow
          : ResolveHookPayload<T, A> & { type: KeyTypeFilter<S> }
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
   * `<name>All` (for `onAny`), and `<name>AlarmsF<hash>` for a type-filtered
   * registration (one per distinct type set).
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
// Separates the base type from the filter-group hash in an internal topicKey
// (`alarms~1a2b3c`). Not alphanumeric, so it can never clash with a type name.
const FILTER_SEP = '~'

/**
 * A type-filter group: the canonical (deduped, code-point sorted) set of message
 * types one topic forwards. Identified by a stable hash that is part of the
 * topic name, so the same set always maps to the same platform resources.
 */
interface FilterGroup {
  id: string
  types: readonly string[]
  odata: string
  set: ReadonlySet<string>
}

/**
 * The Cumulocity alphanumeric subscription/subscriber-name rule: a `name` must
 * consist solely of ASCII letters and digits and be non-empty. Mirrors the C8Y
 * core OpenAPI `NotificationSubscription.subscription` pattern (`^[a-zA-Z0-9]+$`,
 * `minLength: 1`) exactly, so both cases are accepted. This is the single source
 * of truth used by the {@link RealtimeClient} constructor; export it so
 * downstream consumers can validate/derive a `name` without hardcoding a
 * divergent copy of the rule.
 */
export const REALTIME_NAME_REGEX = /^[a-zA-Z0-9]+$/

/**
 * The minimum length of a realtime/subscription `name`, mirroring the C8Y core
 * OpenAPI `NotificationSubscription.subscription` `minLength: 1`.
 */
export const REALTIME_NAME_MIN_LENGTH = 1

/**
 * True iff `name` is a legal Cumulocity realtime/subscription name: alphanumeric
 * (per {@link REALTIME_NAME_REGEX}) **and** non-empty (per
 * {@link REALTIME_NAME_MIN_LENGTH}), matching the C8Y core OpenAPI
 * `NotificationSubscription.subscription` schema.
 *
 * @param name
 * @returns whether `name` is a valid realtime/subscription name
 */
export function isValidRealtimeName(name: string): boolean {
  // The length check is technically implied by the regex `+` quantifier, but is
  // kept explicit so the spec's `minLength` is encoded independently of the
  // pattern.
  return name.length >= REALTIME_NAME_MIN_LENGTH && REALTIME_NAME_REGEX.test(name)
}

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
 * One topic + one consumer **per notification type** (plus one for `onAny`, and
 * one per distinct type-filter set, see the module docs).
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
  readonly events: FilterableTypeHooks<C8yEvent>
  /**
   * Alarm notifications.
   */
  readonly alarms: FilterableTypeHooks<Alarm>
  /**
   * Operation notifications (no type filter: operations carry no `type`).
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

  // Filter groups by topicKey (`<type>~<hash>`), for topic naming, the
  // typeFilter on each subscription, the dispatch guard and public keys.
  readonly #filterGroups = new Map<string, FilterGroup>()

  // One consumer per topicKey (per type, per (type, filter group), + '*' for onAny).
  readonly #topicKeys = new Set<string>()
  readonly #topicStarted = new Set<string>()
  readonly #topicConsumers = new Map<string, () => Promise<void>>()
  // Topics whose consumer ended on its own (fatal error — e.g. revoked creds),
  // NOT via an intentional close. Drained by updateCredentials to restart them.
  readonly #stoppedTopics = new Set<string>()

  // Per-topic bounded duplicate suppression (must be per-topic: the same event
  // legitimately arrives on both its type topic and the onAny topic).
  readonly #dedup = new Map<string, { seen: Set<string>, order: string[] }>()

  #closing = false

  constructor(options: RealtimeClientOptions) {
    this.#client = createNotificationClient(options)
    this.#logger = options.logger ?? { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    if (!options.name || !isValidRealtimeName(options.name)) {
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
      onCreate: this.#reg<Measurement, FilterableRegister<Measurement, string>>('measurements', 'create'),
      onUpdate: this.#reg<Measurement, FilterableRegister<Measurement, string>>('measurements', 'update'),
      onDelete: this.#reg<DeletionPayload, FilterOnlyRegister<DeletionPayload, string>>('measurements', 'delete'),
      onAny: this.#reg<Measurement | DeletionPayload, FilterOnlyRegister<Measurement | DeletionPayload, string>>('measurements', WILDCARD),
    }
    this.managedObjects = {
      onCreate: this.#reg<ManagedObject, FilterableRegister<ManagedObject, '*'>>('managedobjects', 'create'),
      onUpdate: this.#reg<ManagedObject, FilterableRegister<ManagedObject, string>>('managedobjects', 'update'),
      onDelete: this.#reg<DeletionPayload, FilterOnlyRegister<DeletionPayload, string>>('managedobjects', 'delete'),
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
   * rt.hook('alarms:create:*:c8y_TemperatureAlarm', (alarm) => {}) // type-filtered
   * rt.hook('events:create:*:c8y_A|c8y_B', (ev) => {})            // several types
   * rt.hook<'alarms:create:*:c8y_X', MyAlarm>('alarms:create:*:c8y_X', (a) => {}) // + your payload type
   * rt.hook('*', (payload, n) => {}) // firehose — same as rt.onAny(handler)
   * ```
   */
  hook<K extends RealtimeHookKey, Q extends HookKeyConstraint<K> = HookKeyConstraint<K>>(
    key: K,
    // Invalid-filter keys (operations, empty segment) are rejected on the handler
    // type, not via `key: K & ValidHookKey<K>`: an intersection on `key` breaks
    // inference of K for template-literal keys such as `alarms:create:${scope}`.
    handler: [ValidHookKey<K>] extends [never] ? never : NotificationHandler<HookKeyPayload<K> & Q>,
    label?: string,
  ): Unsubscribe {
    const h = handler as unknown as NotificationHandler<unknown>
    if (key === WILDCARD)
      return this.#register(WILDCARD, WILDCARD, WILDCARD, h, label)
    const { type, action, scope, types } = parseHookKey(key)
    return this.#register(scope, type, action, h, label, types)
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
      throw new TypeError('realtime: onAny needs a handler function (optionally preceded by a source id)')
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
    const hookKey = tryToHookKey(key)
    return hookKey ? this.#removeAll(hookKey, true) : { removed: false, count: 0, subscriptionDeleted: false }
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
    const hookKey = tryToHookKey(key)
    return hookKey ? this.#removeAll(hookKey, false) : { removed: false, count: 0, subscriptionDeleted: false }
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
    const hookKey = tryToHookKey(key)
    return hookKey ? (this.#hookHandlers.get(hookKey)?.size ?? 0) > 0 : false
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
        keys.push(this.#toPublicKey(hookKey) as RealtimeHookKey)
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
   * `true` while no consumer has stopped unexpectedly — i.e. the client is
   * running normally (or has nothing to run). Goes `false` when a consumer hits
   * a fatal error (e.g. its credentials ran out) and gives up. A live socket
   * still holds a valid token, so it stays healthy until it drops. This is the
   * gate for {@link updateCredentials}: you may only replace credentials while
   * `healthy` is `false`.
   */
  get healthy(): boolean {
    return this.#stoppedTopics.size === 0
  }

  /**
   * Replace this client's credentials **after it has gone unhealthy** — a
   * consumer stopped because its credentials ran out (rotation) or were revoked
   * (unsubscribe→resubscribe). Handlers and remote subscriptions are kept; the
   * stopped consumers are reconnected with the new credentials. The `tenant` and
   * `baseUrl` must stay the same — only the user/password may change (a different
   * tenant is a different client).
   *
   * You may **only** call this while {@link healthy} is `false`. Replacing the
   * credentials of a live, healthy client is not allowed — its sockets already
   * hold valid tokens, so there is nothing to repair — and the promise
   * **rejects** without touching anything.
   *
   * When unhealthy, it then **validates** the new credentials with one read-only
   * probe:
   *
   * - **They fail to authenticate** → the promise **rejects and nothing
   *   changes**. The previous credentials are kept (they were valid at some
   *   point), the client stays unhealthy, and the caller can retry with the next
   *   set of credentials.
   * - **They authenticate** → swap the credential source (every future token
   *   mint and REST call uses them), then restart exactly the stopped consumers,
   *   reusing their remote subscriptions. Any still-healthy consumer keeps its
   *   socket and migrates on its own next natural reconnect — no forced drop.
   *
   * @param credentials - The replacement tenant credentials.
   * @throws if the client is still {@link healthy}, or if the new credentials do
   *   not authenticate — in either case the client is left unchanged.
   */
  async updateCredentials(credentials: TenantCredentials): Promise<void> {
    // A healthy client has nothing to repair: its live sockets still hold valid
    // tokens. Swapping creds underneath them is disallowed — reject untouched.
    if (this.healthy) {
      throw new Error(
        'realtime: cannot update credentials while the client is healthy — credentials can only be replaced after a consumer has stopped (e.g. its credentials ran out).',
      )
    }

    // Validate against a throwaway client, so bad credentials never clobber the
    // previous (once-valid) ones. Throws (e.g. 401/403) without side effects.
    await this.#client.verifyCredentials(credentials)

    // Validated — swap the source in memory. Any still-healthy socket keeps running.
    this.#client.setCredentials(credentials)

    // Restart exactly the topics whose consumer had already stopped.
    // Reuse the existing remote subscription (#subs untouched); just re-open the
    // consumer, which re-mints a token from the new credentials. Dedup state is
    // preserved (we do not route through #closeConsumer) so a persistent resume
    // does not re-fire already-processed messages.
    for (const topicKey of [...this.#stoppedTopics]) {
      this.#stoppedTopics.delete(topicKey)
      // A topic can only be restarted if it is still wanted (handlers remain).
      if (!this.#topicKeys.has(topicKey))
        continue
      this.#topicConsumers.delete(topicKey)
      this.#topicStarted.delete(topicKey)
      this.#ensureTopicConsumer(topicKey)
    }
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

  #dualNamespace<P>(type: NotificationTypeName): FilterableTypeHooks<P> {
    return {
      onCreate: this.#reg<P, FilterableRegister<P, SourceScope>>(type, 'create'),
      onUpdate: this.#reg<P, FilterableRegister<P, SourceScope>>(type, 'update'),
      onDelete: this.#reg<DeletionPayload, FilterOnlyRegister<DeletionPayload, SourceScope>>(type, 'delete'),
      onAny: this.#reg<P | DeletionPayload, FilterOnlyRegister<P | DeletionPayload, SourceScope>>(type, WILDCARD),
    }
  }

  #reg<P, R>(type: string, action: string): R {
    return ((a: unknown, b?: NotificationHandler<P>, c?: string) => {
      const { scope, handler, label, types } = parseScopeArgs(a, b as NotificationHandler<unknown> | undefined, c)
      return this.#register(scope, type, action, handler, label, types)
    }) as R
  }

  // ── registration & dispatch ──────────────────────────────────────────────

  /**
   * Register one handler. `type` is a notification type, or '*' for onAny;
   * `types` (canonical, non-empty) turns it into a filtered registration on its
   * own filter-group topic. The resulting **topicKey** (`type`, or
   * `type~<hash>`) is what all per-topic state is keyed by.
   * @param scope
   * @param type
   * @param action
   * @param handler
   * @param label
   * @param types
   */
  #register(scope: string, type: string, action: string, handler: NotificationHandler<unknown>, label?: string, types?: readonly string[]): Unsubscribe {
    if (label != null && this.#labels.has(label)) {
      throw new Error(
        `realtime: a hook labeled ${JSON.stringify(label)} is already registered on this client; labels must be unique.`,
      )
    }
    const topicKey = types ? this.#filterTopicKey(type, types) : type
    const hookKey = `${scope}#${topicKey}:${action}`
    const subKey = `${topicKey}#${scope}`
    const wrapped = (payload: unknown, notification: Notification<unknown>): void | Promise<void> =>
      handler(payload, notification)
    const unhook = this.#hooks.hook(hookKey, wrapped as never)
    const entry: HandlerEntry = { hookKey, subKey, type: topicKey, scope, label, unhook, removed: false }

    let set = this.#hookHandlers.get(hookKey)
    if (!set) {
      set = new Set()
      this.#hookHandlers.set(hookKey, set)
    }
    set.add(entry)
    if (label != null)
      this.#labels.set(label, entry)
    this.#subHandlerCount.set(subKey, (this.#subHandlerCount.get(subKey) ?? 0) + 1)
    let scopes = this.#typeScopes.get(topicKey)
    if (!scopes) {
      scopes = new Set()
      this.#typeScopes.set(topicKey, scopes)
    }
    scopes.add(scope)

    this.#topicKeys.add(topicKey)
    this.#ensureSub(topicKey, scope)
    if (this.#autoStart)
      this.#ensureTopicConsumer(topicKey)

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
        this.#filterGroups.delete(entry.type)
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
    // The topic is being intentionally removed — never let a prior unexpected
    // stop resurrect it on the next updateCredentials.
    this.#stoppedTopics.delete(topicKey)
    if (close)
      close().catch(() => {})
  }

  /**
   * Platform topic name for a topicKey: `<name>All` (onAny), `<name><Type>`
   * (unfiltered), or `<name><Type>F<hash>` (a filter group).
   * @param topicKey
   */
  #topicName(topicKey: string): string {
    if (topicKey === WILDCARD)
      return `${this.#base}All`
    const [type, hash] = splitTopicKey(topicKey)
    return hash ? `${this.#base}${capitalize(type)}F${hash}` : `${this.#base}${capitalize(type)}`
  }

  /**
   * Resolve (and memoize) the filter group for a canonical type set, returning
   * its topicKey `<type>~<hash>`. Rejects filters where they cannot apply.
   * @param type
   * @param types
   */
  #filterTopicKey(type: string, types: readonly string[]): string {
    if (type === WILDCARD || type === 'operations') {
      throw new TypeError(
        `realtime: a type filter is not supported for ${type === WILDCARD ? 'the onAny firehose' : 'operations (no \`type\` field)'}`,
      )
    }
    const group = toFilterGroup(types)
    const topicKey = `${type}${FILTER_SEP}${group.id}`
    const existing = this.#filterGroups.get(topicKey)
    if (existing) {
      if (existing.odata !== group.odata)
        throw new Error(`realtime: filter hash collision between ${JSON.stringify(existing.types)} and ${JSON.stringify(group.types)}`)
      return topicKey
    }
    this.#filterGroups.set(topicKey, group)
    return topicKey
  }

  /**
   * Ensure the single-type subscription for `(topicKey, scope)` exists. Created
   * once; never modified. Its apis are exactly `[type]` (or `['*']` for onAny)
   * and — for a filter group — its `typeFilter` is the group's OData expression.
   * It forwards the **full** message (no `fragmentsToCopy`), so any number of
   * handlers can share one `(topicKey, scope)` stream without conflict.
   * @param topicKey
   * @param scope
   */
  #ensureSub(topicKey: string, scope: string): void {
    const key = `${topicKey}#${scope}`
    if (this.#subs.has(key) || !this.#ensureSubscription)
      return
    const isTenant = scope === WILDCARD
    const [type] = splitTopicKey(topicKey)
    const group = this.#filterGroups.get(topicKey)
    const subscription: Subscription = {
      context: isTenant ? 'tenant' : 'mo',
      subscription: this.#topicName(topicKey),
      source: isTenant ? undefined : { id: scope },
      nonPersistent: this.#nonPersistent,
      subscriptionFilter: {
        apis: topicKey === WILDCARD ? [...this.#apis] : [type as SubscriptionApi],
        ...(group ? { typeFilter: group.odata } : {}),
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
    // The consumer's run loop ended. An intentional teardown (#closeConsumer /
    // close()) clears #topicStarted first, or sets #closing — so if the topic is
    // still started and we are not closing, it stopped on its own (a fatal error
    // such as revoked credentials). Mark it for updateCredentials to restart.
    if (!this.#closing && this.#topicStarted.has(topicKey)) {
      this.#stoppedTopics.add(topicKey)
      this.#logger.warn(`realtime: consumer for ${this.#topicName(topicKey)} stopped unexpectedly (call updateCredentials to restart it)`)
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

    // On a filter-group topic the server already filtered by `type`; guard anyway
    // so a handler typed for `c8y_X` never sees anything else.
    const group = this.#filterGroups.get(topicKey)
    if (group) {
      const payloadType = (notification.payload as { type?: unknown } | undefined)?.type
      if (typeof payloadType === 'string' && !group.set.has(payloadType)) {
        // Should never fire (the server filtered already); warn so a grammar
        // mismatch is visible, and always ack — the user never sees this frame.
        this.#logger.warn(`realtime: dropped ${type}:${action} of type ${JSON.stringify(payloadType)} not in filter ${group.odata}`)
        notification.ack()
        return
      }
    }

    // The onAny ('*') topic fires onAny handlers; a typed topic fires that type's
    // handlers; a filter-group topic fires that group's handlers (keyed by its topicKey).
    // Unfiltered topics route on the frame's own type (as before); a filter-group
    // topic is its own routing key.
    const routeType = group ? topicKey : type
    const keys = topicKey === WILDCARD
      ? new Set<string>([
          `${source}#${WILDCARD}:${WILDCARD}`,
          `${WILDCARD}#${WILDCARD}:${WILDCARD}`,
        ])
      : new Set<string>([
          `${source}#${routeType}:${action}`,
          `${WILDCARD}#${routeType}:${action}`,
          `${source}#${routeType}:${WILDCARD}`,
          `${WILDCARD}#${routeType}:${WILDCARD}`,
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
   * Inverse of {@link toHookKey}: map an internal `"<scope>#<topicKey>:<action>"`
   * key back to the public `"<type>:<action>:<scope>[:<types>]"` form (the scope
   * segment is always present, `'*'` for all devices; a filter group's types are
   * appended canonically as the 4th segment).
   * @param hookKey
   */
  #toPublicKey(hookKey: string): string {
    if (hookKey === `${WILDCARD}#${WILDCARD}:${WILDCARD}`)
      return WILDCARD
    const at = hookKey.indexOf('#')
    const scope = hookKey.slice(0, at)
    const colon = hookKey.indexOf(':', at)
    const topicKey = hookKey.slice(at + 1, colon)
    const action = hookKey.slice(colon + 1)
    const [type] = splitTopicKey(topicKey)
    const group = this.#filterGroups.get(topicKey)
    return `${type}:${action}:${scope}${group ? typeSegment(group.types) : ''}`
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
 * Split an internal topicKey into `[type, hash]` (`hash` is `undefined` for an
 * unfiltered topic).
 * @param topicKey
 */
function splitTopicKey(topicKey: string): [type: string, hash: string | undefined] {
  const at = topicKey.indexOf(FILTER_SEP)
  return at === -1 ? [topicKey, undefined] : [topicKey.slice(0, at), topicKey.slice(at + 1)]
}

/**
 * Parse a public hook key `"<type>:<action>:<scope>[:<types>]"`. The scope is
 * required (absent/empty ⇒ `*`). Everything after the third `:` is the type
 * filter: types separated by `|`, with `%7C` for a literal `|` and `%25` for a
 * literal `%`. (Percent escapes, not backslashes: `'a\|b'` in a JS string
 * literal is silently just `a|b`, so a backslash grammar would fail without any
 * error.)
 * @param key
 */
function parseHookKey(key: string): { type: string, action: string, scope: string, types: readonly string[] | undefined } {
  const [type = '', action = '', id, ...rest] = key.split(':')
  const scope = id && id.length > 0 ? id : WILDCARD
  const types = rest.length > 0 ? canonicalTypes(rest.join(':').split('|').map(decodeTypeSegment)) : undefined
  return { type, action, scope, types }
}

/**
 * Decode one type from a key's filter segment (`%7C` → `|`, `%25` → `%`).
 * @param encoded
 */
function decodeTypeSegment(encoded: string): string {
  return encoded.replace(/%7C|%25/gi, (m) => (m.toUpperCase() === '%7C' ? '|' : '%'))
}

/**
 * Encode one type for a key's filter segment (`%` → `%25`, `|` → `%7C`).
 * @param type
 */
function encodeTypeSegment(type: string): string {
  return type.replaceAll('%', '%25').replaceAll('|', '%7C')
}

/**
 * {@link toHookKey} for the query/remove methods: a malformed filter segment
 * (which `hook()` would reject with a TypeError) is simply "no such key".
 * @param key
 */
function tryToHookKey(key: string): string | undefined {
  try {
    return toHookKey(key)
  } catch {
    return undefined
  }
}

/**
 * Map a public hook key to the internal `"<scope>#<topicKey>:<action>"` form.
 * Mirrors the resolution in {@link RealtimeClient.hook}.
 * @param key
 */
function toHookKey(key: string): string {
  if (key === WILDCARD)
    return `${WILDCARD}#${WILDCARD}:${WILDCARD}`
  const { type, action, scope, types } = parseHookKey(key)
  const topicKey = types ? `${type}${FILTER_SEP}${toFilterGroup(types).id}` : type
  return `${scope}#${topicKey}:${action}`
}

/**
 * Canonicalize a type filter: deduped, sorted by UTF-16 code unit (the default
 * `sort()` order — deterministic, which is all the hash needs), no empty entries.
 * @param input
 */
function canonicalTypes(input: string | readonly string[]): readonly string[] {
  const list = typeof input === 'string' ? [input] : [...input]
  if (list.length === 0 || list.some((t) => typeof t !== 'string' || t.length === 0)) {
    throw new TypeError(
      `realtime: invalid type filter ${JSON.stringify(input)} — needs at least one type, and every type must be a non-empty string (in a key, check for a trailing or doubled "|")`,
    )
  }
  return [...new Set(list)].sort()
}

/**
 * Build the filter group (hash, OData expression, lookup set) for a canonical
 * type set. Pure, so the same set always yields the same group id.
 * @param types
 */
function toFilterGroup(types: readonly string[]): FilterGroup {
  return {
    id: fnv1a64Base36(types.map(encodeTypeSegment).join('|')),
    types,
    odata: types.map((t) => `'${t.replaceAll('\'', '\'\'')}'`).join(' or '),
    set: new Set(types),
  }
}

/**
 * The canonical public 4th key segment for a type set: `:a|b|c`.
 * @param types
 */
function typeSegment(types: readonly string[]): string {
  return `:${types.map(encodeTypeSegment).join('|')}`
}

/**
 * 64-bit FNV-1a over the UTF-16 code units of `input`, base36-encoded (≤ 13
 * chars, alphanumeric) — stable across runs and runtimes.
 * @param input
 */
function fnv1a64Base36(input: string): string {
  const prime = 0x100000001B3n
  const mask = 0xFFFFFFFFFFFFFFFFn
  let hash = 0xCBF29CE484222325n
  for (let i = 0; i < input.length; i++) {
    const unit = input.charCodeAt(i)
    hash = ((hash ^ BigInt(unit & 0xFF)) * prime) & mask
    hash = ((hash ^ BigInt(unit >> 8)) * prime) & mask
  }
  return hash.toString(36)
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
 * scope is required: a `'*'`/id string, or a {@link FilteredScope} object; an
 * empty string is treated as the all-devices `*` scope.
 * @param a
 * @param b
 * @param c
 */
function parseScopeArgs(
  a: unknown,
  b: NotificationHandler<unknown> | undefined,
  c: string | undefined,
): { scope: string, handler: NotificationHandler<unknown>, label: string | undefined, types: readonly string[] | undefined } {
  const usage = 'realtime: a register takes (scope, handler, label?) — scope is "*" (all devices), a device id, or { source, type }'
  if (typeof b !== 'function')
    throw new TypeError(`${usage}; the handler is missing or not a function`)
  const label = typeof c === 'string' ? c : undefined
  if (typeof a === 'string')
    return { scope: a.length > 0 ? a : WILDCARD, handler: b, label, types: undefined }
  if (a && typeof a === 'object' && typeof (a as { source?: unknown }).source === 'string') {
    const { source, type } = a as { source: string, type?: unknown }
    if (typeof type !== 'string' && !Array.isArray(type))
      throw new TypeError(`${usage}; { source, type } needs a \`type\` (one type string, or a list of them)`)
    return { scope: source.length > 0 ? source : WILDCARD, handler: b, label, types: canonicalTypes(type as string | string[]) }
  }
  throw new TypeError(`${usage}; got scope ${JSON.stringify(a)} (a { source } must be a string)`)
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
 * rt.alarms.onCreate({ source: '*', type: 'c8y_TemperatureAlarm' }, (alarm) => {}) // type-filtered
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
