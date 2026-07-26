/**
 * Minimal authenticated REST layer built on native `fetch`. No dependency on
 * `@c8y/client`.
 */
import { Buffer } from 'node:buffer'
import { C8yHttpError } from './errors'
import type { TenantCredentials } from './types'

/**
 * Build the HTTP Basic auth header value for Cumulocity.
 *
 * The username is the tenant-qualified form `"<tenant>/<user>"`.
 *
 * @param tenant
 * @param user
 * @param password
 * @returns e.g. `"Basic dDEyMy9hZG1pbjpzZWNyZXQ="`
 */
export function basicAuthHeader(tenant: string, user: string, password: string): string {
  const encoded = Buffer.from(`${tenant}/${user}:${password}`, 'utf8').toString('base64')
  return `Basic ${encoded}`
}

/**
 * Normalize a base URL, ensuring it has a protocol and no trailing slash.
 * A bare host (no scheme) is assumed to be `https`.
 * @param baseUrl
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(trimmed))
    return trimmed
  return `https://${trimmed}`
}

/**
 * Join a normalized base URL with a path segment, tolerating leading/trailing
 * slashes on either side.
 * @param baseUrl
 * @param path
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl)
  const suffix = path.replace(/^\/+/, '')
  return `${base}/${suffix}`
}

/**
 * Derive the WebSocket URL scheme from an HTTP base URL:
 * `https` -> `wss`, `http` -> `ws`. A bare host is assumed secure (`wss`).
 * @param baseUrl
 * @param path
 */
export function toWebSocketUrl(baseUrl: string, path: string): string {
  const httpUrl = joinUrl(baseUrl, path)
  return httpUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://')
}

/**
 * Internal REST client bound to a single tenant's credentials.
 */
export class HttpClient {
  readonly #authHeader: string
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor(credentials: TenantCredentials, fetchImpl: typeof fetch = fetch) {
    this.#baseUrl = normalizeBaseUrl(credentials.baseUrl)
    this.#authHeader = basicAuthHeader(credentials.tenant, credentials.user, credentials.password)
    this.#fetch = fetchImpl
  }

  get baseUrl(): string {
    return this.#baseUrl
  }

  /**
   * Perform an authenticated JSON request. Throws {@link C8yHttpError} on any
   * non-2xx response (except when `allowStatuses` lists the status). Returns
   * the parsed JSON body, or `undefined` for empty responses.
   * @param method
   * @param path
   * @param options
   * @param options.body
   * @param options.headers
   * @param options.query
   * @param options.allowStatuses
   */
  async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown
      headers?: Record<string, string>
      query?: Record<string, string | number | boolean | undefined>
      allowStatuses?: number[]
    } = {},
  ): Promise<{ status: number, data: T | undefined }> {
    const url = this.#withQuery(joinUrl(this.#baseUrl, path), options.query)
    const headers: Record<string, string> = {
      Authorization: this.#authHeader,
      Accept: 'application/json',
      ...options.headers,
    }
    if (options.body !== undefined && headers['Content-Type'] === undefined)
      headers['Content-Type'] = 'application/json'

    const response = await this.#fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    const data = await this.#parseBody(response)

    if (!response.ok && !(options.allowStatuses?.includes(response.status))) {
      throw new C8yHttpError({
        status: response.status,
        statusText: response.statusText,
        url,
        body: data,
        method,
      })
    }

    return { status: response.status, data: data as T | undefined }
  }

  #withQuery(url: string, query?: Record<string, string | number | boolean | undefined>): string {
    if (!query)
      return url
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined)
        params.set(key, String(value))
    }
    const qs = params.toString()
    return qs ? `${url}?${qs}` : url
  }

  async #parseBody(response: Response): Promise<unknown> {
    const text = await response.text()
    if (text.length === 0)
      return undefined
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('json') || text.startsWith('{') || text.startsWith('[')) {
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    return text
  }
}
