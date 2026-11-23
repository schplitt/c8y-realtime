/**
 * REST operations against `notification2/subscriptions` and `notification2/token`.
 */
import { C8yHttpError, C8ySubscriptionMismatchError } from './errors'
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

/**
 * Result of {@link SubscriptionsApi.ensureDetailed}.
 */
export interface EnsureResult {
  /**
   * `true` if this call created the subscription; `false` if it already
   * existed (HTTP 409) and the existing resource (same name and source; name
   * only for a tenant subscription requested without a source), which matches
   * the requested one, was returned instead. An existing subscription that
   * differs (other context, `nonPersistent`, `apis`, `typeFilter`, or
   * `fragmentsToCopy`) throws {@link C8ySubscriptionMismatchError} instead.
   */
  created: boolean
  subscription: SubscriptionResponse
}
const TOKEN_PATH = 'notification2/token'
const UNSUBSCRIBE_PATH = 'notification2/unsubscribe'

/**
 * Names of the fields in which an existing subscription differs from the
 * requested one. Missing values compare as their defaults
 * (`nonPersistent: false`, no apis, empty `typeFilter`, no `fragmentsToCopy`);
 * `apis` and `fragmentsToCopy` compare as sets.
 * @param existing
 * @param requested
 */
function subscriptionMismatches(existing: Subscription, requested: Subscription): string[] {
  const sameSet = (a: readonly string[] = [], b: readonly string[] = []): boolean => {
    const sa = new Set(a)
    const sb = new Set(b)
    return sa.size === sb.size && [...sa].every((v) => sb.has(v))
  }
  const fields: string[] = []
  if (existing.context !== requested.context)
    fields.push('context')
  if ((existing.nonPersistent ?? false) !== (requested.nonPersistent ?? false))
    fields.push('nonPersistent')
  if (!sameSet(existing.subscriptionFilter?.apis, requested.subscriptionFilter?.apis))
    fields.push('apis')
  if ((existing.subscriptionFilter?.typeFilter ?? '') !== (requested.subscriptionFilter?.typeFilter ?? ''))
    fields.push('typeFilter')
  if (!sameSet(existing.fragmentsToCopy, requested.fragmentsToCopy))
    fields.push('fragmentsToCopy')
  return fields
}

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
   * Ensure a subscription exists. A create that returns HTTP 409 (conflict /
   * already exists) is treated as success, and the existing subscription is
   * returned, as long as it matches the requested one. The platform's
   * duplicate key is `(source, context, name)` and ignores the filter, so an
   * existing subscription with a different context, `nonPersistent`, `apis`,
   * `typeFilter`, or `fragmentsToCopy` throws
   * {@link C8ySubscriptionMismatchError}; delete it to apply the new one.
   * The existing subscription is found by name and source (name only for a
   * tenant subscription requested without a source, since the platform fills
   * in its source). A 409 with no matching existing subscription throws a
   * plain 409 {@link C8yHttpError}.
   * Use {@link ensureDetailed} to learn whether it was created or adopted.
   * @param subscription
   */
  async ensure(subscription: Subscription): Promise<SubscriptionResponse> {
    return (await this.ensureDetailed(subscription)).subscription
  }

  /**
   * {@link ensure}, also reporting whether this call **created** the
   * subscription (`created: true`) or found an existing one after a 409
   * (`created: false`) — so a caller can tell what it owns. Throws
   * {@link C8ySubscriptionMismatchError} and a plain 409 {@link C8yHttpError}
   * like {@link ensure}.
   * @param subscription
   */
  async ensureDetailed(subscription: Subscription): Promise<EnsureResult> {
    const { status, data } = await this.#http.request<SubscriptionResponse>('POST', SUBSCRIPTIONS_PATH, {
      body: subscription,
      allowStatuses: [409],
    })

    if (status !== 409 && data)
      return { created: true, subscription: data }

    // Already exists: look it up so the caller still gets a concrete resource.
    const existing = await this.list({
      subscription: subscription.subscription,
      source: subscription.source?.id,
      context: subscription.context,
    })
    // Only an exact `(name, source)` match can be what caused the 409, except
    // for a tenant subscription requested without a source: the platform fills
    // in its source itself (the tenant as a managed object), so match by name.
    const match = existing.subscriptions.find(
      (s) => s.subscription === subscription.subscription
        && ((subscription.context === 'tenant' && subscription.source === undefined)
          || (s.source?.id ?? undefined) === (subscription.source?.id ?? undefined)),
    )

    if (match) {
      const fields = subscriptionMismatches(match, subscription)
      if (fields.length > 0)
        throw new C8ySubscriptionMismatchError({ existing: match, requested: subscription, fields })
      return { created: false, subscription: match }
    }

    // 409 without a discoverable existing resource: surface it honestly.
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
