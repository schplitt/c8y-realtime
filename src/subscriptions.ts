/**
 * REST operations against `notification2/subscriptions` and `notification2/token`.
 */
import { C8yHttpError } from './errors'
import type { HttpClient } from './http'
import type {
  NotificationTokenOptions,
  Subscription,
  SubscriptionCollection,
  SubscriptionListFilter,
  SubscriptionResponse,
  TokenResponse,
} from './types'

const SUBSCRIPTIONS_PATH = 'notification2/subscriptions'
const TOKEN_PATH = 'notification2/token'
const UNSUBSCRIBE_PATH = 'notification2/unsubscribe'

/**
 * Typed REST API for managing Notification 2.0 subscriptions.
 */
export class SubscriptionsApi {
  readonly #http: HttpClient

  constructor(http: HttpClient) {
    this.#http = http
  }

  /**
   * List subscriptions matching an optional filter.
   * @param filter
   */
  async list(filter: SubscriptionListFilter = {}): Promise<SubscriptionCollection> {
    const { data } = await this.#http.request<SubscriptionCollection>('GET', SUBSCRIPTIONS_PATH, {
      query: {
        subscription: filter.subscription,
        source: filter.source,
        context: filter.context,
        pageSize: filter.pageSize,
        currentPage: filter.currentPage,
        withTotalPages: filter.withTotalPages,
      },
    })
    return data ?? { subscriptions: [] }
  }

  /**
   * Fetch a single subscription by its server-assigned id.
   * @param id
   */
  async get(id: string): Promise<SubscriptionResponse> {
    const { data } = await this.#http.request<SubscriptionResponse>('GET', `${SUBSCRIPTIONS_PATH}/${encodeURIComponent(id)}`)
    if (!data)
      throw new C8yHttpError({ status: 404, statusText: 'Not Found', url: id, body: undefined, method: 'GET' })
    return data
  }

  /**
   * Create a subscription.
   * @param subscription
   */
  async create(subscription: Subscription): Promise<SubscriptionResponse> {
    const { data } = await this.#http.request<SubscriptionResponse>('POST', SUBSCRIPTIONS_PATH, {
      body: subscription,
    })
    // A successful create always returns the created resource.
    return data as SubscriptionResponse
  }

  /**
   * Ensure a subscription exists. Mirrors the reference implementation's
   * controller-helper: a create that returns HTTP 409 (conflict / already
   * exists) is treated as success, and the existing subscription is returned.
   * @param subscription
   */
  async ensure(subscription: Subscription): Promise<SubscriptionResponse> {
    const { status, data } = await this.#http.request<SubscriptionResponse>('POST', SUBSCRIPTIONS_PATH, {
      body: subscription,
      allowStatuses: [409],
    })

    if (status !== 409 && data)
      return data

    // Already exists: look it up so the caller still gets a concrete resource.
    const existing = await this.list({
      subscription: subscription.subscription,
      source: subscription.source?.id,
      context: subscription.context,
    })
    const match = existing.subscriptions.find(
      (s) => s.subscription === subscription.subscription
        && (s.source?.id ?? undefined) === (subscription.source?.id ?? undefined),
    ) ?? existing.subscriptions[0]

    if (match)
      return match

    // 409 without a discoverable existing resource: surface it honestly.
    if (data)
      return data
    throw new C8yHttpError({
      status: 409,
      statusText: 'Conflict',
      url: SUBSCRIPTIONS_PATH,
      body: undefined,
      method: 'POST',
    })
  }

  /**
   * Delete a subscription by id. Treats 404 as already-gone success.
   * @param id
   */
  async delete(id: string): Promise<void> {
    await this.#http.request('DELETE', `${SUBSCRIPTIONS_PATH}/${encodeURIComponent(id)}`, {
      allowStatuses: [404],
    })
  }
}

/**
 * Mint a consumer token for a subscription topic.
 * @param http
 * @param options
 */
export async function createToken(http: HttpClient, options: NotificationTokenOptions): Promise<TokenResponse> {
  const { data } = await http.request<TokenResponse>('POST', TOKEN_PATH, {
    body: {
      subscription: options.subscription,
      subscriber: options.subscriber,
      nonPersistent: options.nonPersistent,
      shared: options.shared,
      expiresInMinutes: options.expiresInMinutes,
    },
  })
  if (!data?.token)
    throw new C8yHttpError({ status: 500, statusText: 'Missing token', url: TOKEN_PATH, body: data, method: 'POST' })
  return data
}

/**
 * Unsubscribe (delete) the consumer identified by a token. This removes the
 * consumer and its backlog from the Messaging Service — the durable counterpart
 * to simply disconnecting the websocket, which does NOT remove the consumer.
 *
 * The token's topic must be live (a consumer currently attached) or the server
 * responds 500 "topic not found"; call this while still connected. Treats 404
 * as already-gone success.
 * @param http
 * @param token
 */
export async function unsubscribeConsumer(http: HttpClient, token: string): Promise<void> {
  await http.request('POST', `${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`, {
    allowStatuses: [404],
  })
}
