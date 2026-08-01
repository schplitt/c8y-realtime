/**
 * High-level, framework-agnostic Notification 2.0 client and factories.
 */
import { WebSocketConsumer } from './consumer'
import { HttpClient } from './http'
import { createToken, SubscriptionsApi } from './subscriptions'
import type { ConsumerConfig } from './consumer'
import type {
  ConsumerResilienceOptions,
  Logger,
  NotificationClientOptions,
  NotificationTokenOptions,
  SubscribeOptions,
  TenantCredentials,
  TokenResponse,
  WebSocketFactory,
} from './types'

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const DEFAULT_RESILIENCE: Required<ConsumerResilienceOptions> = {
  pingIntervalMs: 60_000,
  pongTimeoutMs: 10_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
}

/**
 * A Notification 2.0 client scoped to a single tenant's credentials.
 */
export class NotificationClient {
  /**
   * Typed REST access to `notification2/subscriptions`.
   */
  readonly subscriptions: SubscriptionsApi

  readonly #http: HttpClient
  readonly #resilience: Required<ConsumerResilienceOptions>
  readonly #logger: Logger
  readonly #getWebSocket: () => Promise<WebSocketFactory>
  readonly #consumers = new Set<WebSocketConsumer>()
  readonly #credentials: TenantCredentials

  constructor(options: NotificationClientOptions) {
    this.#credentials = {
      baseUrl: options.baseUrl,
      tenant: options.tenant,
      user: options.user,
      password: options.password,
    }
    this.#http = new HttpClient(this.#credentials, options.fetchImpl)
    this.subscriptions = new SubscriptionsApi(this.#http)
    this.#resilience = { ...DEFAULT_RESILIENCE, ...options.resilience }
    this.#logger = options.logger ?? NOOP_LOGGER
    this.#getWebSocket = memoize(() => resolveWebSocket(options.webSocketImpl))
  }

  /**
   * The tenant id this client is bound to.
   */
  get tenant(): string {
    return this.#credentials.tenant
  }

  /**
   * Directly mint a consumer token (rarely needed; `subscribe` does this).
   * @param options
   */
  createToken(options: NotificationTokenOptions): Promise<TokenResponse> {
    return createToken(this.#http, options)
  }

  /**
   * Subscribe to a subscription topic. Returns an async-iterable consumer that
   * mints its own token, opens the WebSocket, and manages keep-alive, token
   * refresh and reconnection internally.
   *
   * @param subscriptionName - The subscription/topic name to consume.
   * @param options
   */
  subscribe(subscriptionName: string, options: SubscribeOptions = {}): WebSocketConsumer {
    // Subscriber (consumer) names must be alphanumeric, like subscription names.
    const subscriber = options.subscriber ?? `${subscriptionName}Consumer`
    const config: ConsumerConfig = {
      baseUrl: this.#credentials.baseUrl,
      autoAck: options.autoAck ?? true,
      consumerName: options.consumerName,
      resilience: this.#resilience,
      logger: this.#logger,
      signal: options.signal,
      getWebSocket: this.#getWebSocket,
      mintToken: async () => {
        const { token } = await createToken(this.#http, {
          subscription: subscriptionName,
          subscriber,
          nonPersistent: options.nonPersistent,
          shared: options.shared,
          expiresInMinutes: options.expiresInMinutes,
        })
        return token
      },
    }

    const consumer = new WebSocketConsumer(config)
    this.#consumers.add(consumer)
    // Drop the consumer from the active set once it stops on its own.
    consumer.closed.then(() => this.#consumers.delete(consumer)).catch(() => {})
    return consumer
  }

  /**
   * Close every active consumer created by this client.
   */
  async close(): Promise<void> {
    const pending = [...this.#consumers].map((consumer) => consumer.close())
    this.#consumers.clear()
    await Promise.all(pending)
  }
}

/**
 * Create a Notification 2.0 client from a single tenant's subscription
 * credentials.
 * @param options
 */
export function createNotificationClient(options: NotificationClientOptions): NotificationClient {
  return new NotificationClient(options)
}

// ── internal helpers ─────────────────────────────────────────────────────────

function memoize<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined
  return () => (cached ??= factory())
}

/**
 * Resolve a WebSocket implementation: an explicit override, else the runtime's
 * global `WebSocket` (Node 22+, browsers, and other modern runtimes).
 * @param override
 */
function resolveWebSocket(override?: WebSocketFactory): Promise<WebSocketFactory> {
  if (override)
    return Promise.resolve(override)
  const globalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket
  if (typeof globalWebSocket === 'function')
    return Promise.resolve(globalWebSocket as WebSocketFactory)
  return Promise.reject(
    new Error('No global WebSocket found — use Node 22+ (or a runtime with a global WebSocket), or pass options.webSocketImpl.'),
  )
}
