/**
 * Typed error hierarchy for the Notification 2.0 SDK.
 */

/**
 * Base class for all errors thrown by this SDK.
 */
export class C8yError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/**
 * Thrown when a REST call returns a non-2xx status. Carries the HTTP status so
 * callers can branch on it (e.g. treat 409 as "already exists").
 */
export class C8yHttpError extends C8yError {
  /**
   * HTTP status code.
   */
  readonly status: number
  /**
   * HTTP status text.
   */
  readonly statusText: string
  /**
   * The request URL (never contains credentials).
   */
  readonly url: string
  /**
   * The parsed or raw response body, when available.
   */
  readonly body: unknown

  constructor(params: {
    status: number
    statusText: string
    url: string
    body: unknown
    method: string
  }) {
    super(`${params.method} ${params.url} failed: ${params.status} ${params.statusText}`)
    this.status = params.status
    this.statusText = params.statusText
    this.url = params.url
    this.body = params.body
  }
}

/**
 * Thrown when the consumer connection cannot be established or recovered.
 */
export class C8yConnectionError extends C8yError {}
