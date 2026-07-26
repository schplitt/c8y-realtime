/**
 * Public type definitions for the Cumulocity Notification 2.0 SDK.
 *
 * These types are modelled directly from the Notification 2.0 protocol
 * specification (see `Notification2.md`). They are intentionally free of any
 * `@c8y/client` or framework coupling.
 */

/**
 * Credentials for a single tenant, exactly as yielded by a Cumulocity
 * multitenant microservice subscription.
 */
export interface TenantCredentials {
  /**
   * Fully-qualified base URL, e.g. `https://mytenant.cumulocity.com`.
   */
  baseUrl: string
  /**
   * Tenant identifier, e.g. `t12345`.
   */
  tenant: string
  /**
   * Service/user name.
   */
  user: string
  /**
   * Password / application secret.
   */
  password: string
}

/**
 * The set of Cumulocity APIs a subscription filter can include.
 *
 * Use `'*'` to include messages from all APIs.
 */
export const SubscriptionApis = {
  alarms: 'alarms',
  alarmsWithChildren: 'alarmsWithChildren',
  events: 'events',
  eventsWithChildren: 'eventsWithChildren',
  managedobjects: 'managedobjects',
  measurements: 'measurements',
  operations: 'operations',
  all: '*',
} as const

/**
 * One of the valid `filter.apis` values.
 */
export type SubscriptionApi = (typeof SubscriptionApis)[keyof typeof SubscriptionApis]

/**
 * Subscription context: managed-object scoped or tenant-wide.
 */
export type SubscriptionContext = 'mo' | 'tenant'

/**
 * Source (managed object) a `mo`-context subscription is scoped to.
 */
export interface SubscriptionSource {
  /**
   * Managed object global identifier (device / source id).
   */
  id: string
}

/**
 * Fine-grained selection of the messages a subscription forwards.
 */
export interface SubscriptionFilter {
  /**
   * APIs to include. Use `['*']` for all.
   */
  apis?: SubscriptionApi[]
  /**
   * Matched against a message's `type` field. Supports a single value or a
   * limited OData `or` expression, e.g. `"'temperature' or 'pressure'"`.
   */
  typeFilter?: string
}

/**
 * A Notification 2.0 subscription as created against
 * `notification2/subscriptions`.
 */
export interface Subscription {
  /**
   * Managed-object or tenant context.
   */
  context: SubscriptionContext
  /**
   * Topic name this subscription forwards to.
   */
  subscription: string
  /**
   * Required when `context` is `'mo'`.
   */
  source?: SubscriptionSource
  /**
   * Whether the backing topic is non-persistent. Defaults to `false`.
   */
  nonPersistent?: boolean
  /**
   * Optional message filter.
   */
  subscriptionFilter?: SubscriptionFilter
  /**
   * Restrict forwarded fragments to this subset.
   */
  fragmentsToCopy?: string[]
}

/**
 * A subscription as returned by the server (includes server-assigned fields).
 */
export interface SubscriptionResponse extends Subscription {
  /**
   * Server-assigned subscription id.
   */
  id: string
  /**
   * Self link.
   */
  self?: string
}

/**
 * Query filter for listing subscriptions.
 */
export interface SubscriptionListFilter {
  /**
   * Filter by topic name.
   */
  subscription?: string
  /**
   * Filter by managed object source id.
   */
  source?: string
  /**
   * Filter by context.
   */
  context?: SubscriptionContext
  /**
   * Page size (server default applies when omitted).
   */
  pageSize?: number
  /**
   * 1-based page index.
   */
  currentPage?: number
  /**
   * Ask the server to compute total pages.
   */
  withTotalPages?: boolean
}

/**
 * Paged collection of subscriptions.
 */
export interface SubscriptionCollection {
  subscriptions: SubscriptionResponse[]
  self?: string
  next?: string
  statistics?: {
    totalPages?: number
    currentPage?: number
    pageSize?: number
  }
}

/**
 * Options for minting a consumer token against `notification2/token`.
 */
export interface NotificationTokenOptions {
  /**
   * Topic name (matches `subscription` on the subscription object).
   */
  subscription: string
  /**
   * Unique consumer identity, allowing resumption across reconnects.
   */
  subscriber: string
  /**
   * Must be `true` to target a non-persistent topic. Defaults to `false`.
   */
  nonPersistent?: boolean
  /**
   * Allow multiple clients to act collectively as this consumer.
   */
  shared?: boolean
  /**
   * Token lifetime in minutes. Defaults to 1440 (server default).
   */
  expiresInMinutes?: number
}

/**
 * Response of a token create request.
 */
export interface TokenResponse {
  token: string
}

/**
 * The parsed notification description header
 * (`/{tenantId}/{type}/{sourceId}`).
 */
export interface NotificationDescription {
  /**
   * Tenant under which the notification was generated.
   */
  tenantId: string
  /**
   * Platform type, e.g. `measurements`, `alarms`, `managedobjects`.
   */
  type: string
  /**
   * Source object id the notification is about.
   */
  sourceId: string
  /**
   * The raw, unparsed description header line.
   */
  raw: string
}

/**
 * A single decoded notification delivered over the consumer WebSocket.
 *
 * @typeParam T - Shape of the parsed JSON payload.
 */
export interface Notification<T = unknown> {
  /**
   * The opaque acknowledgement header (first header line). Send this back to
   * the server to acknowledge the message.
   */
  ackHeader: string
  /**
   * Parsed notification description header.
   */
  description: NotificationDescription
  /**
   * Action string, e.g. `CREATE`, `UPDATE`, `DELETE`.
   */
  action: string
  /**
   * Any additional header lines beyond the first three.
   */
  extraHeaders: string[]
  /**
   * Parsed JSON payload, or the raw string if it was not valid JSON.
   */
  payload: T
  /**
   * The raw payload text.
   */
  rawPayload: string
  /**
   * The complete raw frame as received.
   */
  raw: string
  /**
   * Explicitly acknowledge this notification on the connection it arrived on.
   * Safe to call multiple times; only the first call has an effect. Used with
   * `{ autoAck: false }` for at-least-once processing.
   */
  ack: () => void
}

/**
 * Options for {@link NotificationClient.subscribe}.
 */
export interface SubscribeOptions {
  /**
   * Unique consumer identity used when minting the token. Defaults to
   * `"<subscriptionName>-consumer"`. Must be stable to resume delivery across
   * reconnects.
   */
  subscriber?: string
  /**
   * Acknowledge each notification automatically once the consumer has finished
   * processing it (i.e. after the `for await` body resolves). Defaults to
   * `true`. Set to `false` for explicit {@link Notification.ack} control.
   */
  autoAck?: boolean
  /**
   * Target a non-persistent topic. Defaults to `false`.
   */
  nonPersistent?: boolean
  /**
   * Request a shared consumer token. Defaults to `false`.
   */
  shared?: boolean
  /**
   * Token lifetime in minutes. Defaults to 1440.
   */
  expiresInMinutes?: number
  /**
   * Optional consumer-client name added as the `consumer` URL parameter.
   */
  consumerName?: string
  /**
   * Abort signal to stop the consumer.
   */
  signal?: AbortSignal
}

/**
 * Tunable resilience parameters for the consumer connection.
 */
export interface ConsumerResilienceOptions {
  /**
   * Interval between WebSocket pings in ms. Defaults to 60000.
   */
  pingIntervalMs?: number
  /**
   * How long to wait for a pong before declaring the socket dead. Defaults to 10000.
   */
  pongTimeoutMs?: number
  /**
   * Initial reconnect backoff in ms. Defaults to 1000.
   */
  initialBackoffMs?: number
  /**
   * Maximum reconnect backoff in ms. Defaults to 30000.
   */
  maxBackoffMs?: number
}

/**
 * Minimal structured logger the SDK can emit diagnostics to.
 */
export interface Logger {
  debug: (message: string, ...args: unknown[]) => void
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

/**
 * Options accepted by {@link createNotificationClient}.
 */
export interface NotificationClientOptions extends TenantCredentials {
  /**
   * Resilience tuning for consumer connections.
   */
  resilience?: ConsumerResilienceOptions
  /**
   * Optional logger. Defaults to a no-op logger.
   */
  logger?: Logger
  /**
   * Override the WebSocket implementation (e.g. inject `ws` in Node).
   */
  webSocketImpl?: WebSocketFactory
  /**
   * Override the fetch implementation. Defaults to global `fetch`.
   */
  fetchImpl?: typeof fetch
}

/**
 * A factory that constructs a WebSocket-like instance from a URL. Compatible
 * with both the `ws` package and the native `WebSocket` constructor (the
 * latter without client-side ping/pong keepalive).
 */
export type WebSocketFactory = new (url: string) => WebSocketInstanceLike

/**
 * Instance surface used by the consumer.
 */
export interface WebSocketInstanceLike {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  terminate?: () => void
  ping?: (data?: unknown) => void
  on?: (event: string, listener: (...args: never[]) => void) => void
  addEventListener?: (event: string, listener: (event: unknown) => void) => void
  removeAllListeners?: () => void
}
