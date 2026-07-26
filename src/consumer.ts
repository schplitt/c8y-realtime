/**
 * Resilient Notification 2.0 WebSocket consumer.
 *
 * Exposed as an {@link AsyncIterable} so callers can `for await (const n of ...)`.
 * Internally it mints a fresh token per connection (token refresh), keeps the
 * socket alive with ping/pong, and transparently reconnects with backoff. An
 * intentional {@link WebSocketConsumer.close} sets a teardown flag so no error
 * is surfaced and no reconnect is attempted. Transient failures never tear down
 * the consumer — the last-known-good subscription state is retained and the
 * connection is simply re-established.
 */
import { Buffer } from 'node:buffer'
import { C8yConnectionError, C8yHttpError } from './errors'
import { parseFrame, parsePayload } from './frame'
import type {
  ConsumerResilienceOptions,
  Logger,
  Notification,
  WebSocketFactory,
} from './types'

/**
 * Minimal structural view of a live socket, covering `ws` and native alike.
 */
interface RawSocket {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  terminate?: () => void
  ping?: () => void
  on?: (event: string, listener: (arg1?: unknown, arg2?: unknown) => void) => void
  addEventListener?: (event: string, listener: (event: { data?: unknown }) => void) => void
  removeAllListeners?: () => void
}

/**
 * Fully-resolved resilience knobs.
 */
type ResolvedResilience = Required<ConsumerResilienceOptions>

/**
 * Everything the consumer needs, wired up by the client.
 */
export interface ConsumerConfig {
  baseUrl: string
  /**
   * Mints (or refreshes) a token immediately before each connection attempt.
   */
  mintToken: () => Promise<string>
  /**
   * Resolves the WebSocket implementation (lazily; e.g. dynamic `import('ws')`).
   */
  getWebSocket: () => Promise<WebSocketFactory>
  autoAck: boolean
  consumerName?: string
  resilience: ResolvedResilience
  logger: Logger
  signal?: AbortSignal
}

const DONE: IteratorResult<Notification> = { value: undefined as never, done: true }

/**
 * A resilient, async-iterable consumer for a single subscription topic.
 */
export class WebSocketConsumer implements AsyncIterable<Notification> {
  readonly #config: ConsumerConfig
  readonly #logger: Logger

  // Push/pull queue bridging the socket producer and the async iterator.
  readonly #queue: Notification[] = []
  readonly #waiters: Array<(result: IteratorResult<Notification>) => void> = []

  #isClosing = false
  #finished = false
  #activeSocket: RawSocket | null = null
  #backoff: number
  #lastDelivered: Notification | null = null
  #resolveDone!: () => void
  #wakeDelay: (() => void) | undefined
  readonly #done: Promise<void>

  constructor(config: ConsumerConfig) {
    this.#config = config
    this.#logger = config.logger
    this.#backoff = config.resilience.initialBackoffMs
    this.#done = new Promise((resolve) => {
      this.#resolveDone = resolve
    })

    if (config.signal) {
      if (config.signal.aborted) {
        this.#isClosing = true
      } else {
        config.signal.addEventListener('abort', () => {
          this.close().catch(() => {})
        }, { once: true })
      }
    }

    this.#run().catch(() => {})
  }

  /**
   * Resolves when the consumer has fully stopped (via close or fatal setup).
   */
  get closed(): Promise<void> {
    return this.#done
  }

  /**
   * Async iterator with auto-ack applied after each processed notification.
   */
  [Symbol.asyncIterator](): AsyncIterator<Notification> {
    return {
      next: async (): Promise<IteratorResult<Notification>> => {
        this.#ackLastDelivered()
        const result = await this.#pull()
        if (!result.done)
          this.#lastDelivered = result.value
        return result
      },
      return: async (): Promise<IteratorResult<Notification>> => {
        this.#ackLastDelivered()
        await this.close()
        return DONE
      },
    }
  }

  /**
   * Intentional teardown. Sets the closing flag, closes the socket cleanly, and
   * resolves once the run loop has stopped. Idempotent.
   */
  async close(): Promise<void> {
    if (!this.#isClosing) {
      this.#isClosing = true
      const socket = this.#activeSocket
      if (socket) {
        try {
          socket.close(1000, 'client close')
        } catch {
          this.#terminate(socket)
        }
      }
      this.#flushWaiters()
      // Cut short any pending reconnect backoff so close() resolves promptly.
      this.#wakeDelay?.()
    }
    await this.#done
  }

  #ackLastDelivered(): void {
    if (this.#config.autoAck && this.#lastDelivered) {
      this.#lastDelivered.ack()
      this.#lastDelivered = null
    }
  }

  // ── producer/consumer queue ────────────────────────────────────────────────

  #push(notification: Notification): void {
    const waiter = this.#waiters.shift()
    if (waiter)
      waiter({ value: notification, done: false })
    else
      this.#queue.push(notification)
  }

  #pull(): Promise<IteratorResult<Notification>> {
    const buffered = this.#queue.shift()
    if (buffered)
      return Promise.resolve({ value: buffered, done: false })
    if (this.#finished)
      return Promise.resolve(DONE)
    return new Promise((resolve) => {
      this.#waiters.push(resolve)
    })
  }

  #flushWaiters(): void {
    while (this.#waiters.length > 0)
      this.#waiters.shift()?.(DONE)
  }

  // ── connection lifecycle ───────────────────────────────────────────────────

  async #run(): Promise<void> {
    let WebSocketImpl: WebSocketFactory
    try {
      WebSocketImpl = await this.#config.getWebSocket()
    } catch (error) {
      this.#logger.error('no WebSocket implementation available', error)
      this.#finish()
      return
    }

    while (!this.#isClosing) {
      let opened = false
      try {
        const token = await this.#config.mintToken()
        opened = await this.#connectAndConsume(WebSocketImpl, token)
      } catch (error) {
        if (this.#isClosing)
          break
        // A permanent client error (bad credentials, bad subscriber/topic name,
        // missing permission) will never self-heal — stop instead of looping.
        if (isFatalHttpError(error)) {
          this.#logger.error('consumer stopped: unrecoverable error', error)
          break
        }
        // Transient failure: keep last-known-good subscription state, back off.
        this.#logger.warn('consumer connection attempt failed, retrying', error)
      }

      if (this.#isClosing)
        break

      if (opened) {
        // A previously healthy connection dropped: reconnect promptly.
        this.#backoff = this.#config.resilience.initialBackoffMs
      } else {
        // Never opened: grow the backoff to avoid hammering the server.
        this.#backoff = Math.min(this.#backoff * 2, this.#config.resilience.maxBackoffMs)
      }
      await this.#delay(this.#backoff)
    }

    this.#finish()
  }

  /**
   * Open a socket and pump messages until it closes. Resolves with whether the
   * socket ever reached the OPEN state (used to steer backoff).
   * @param WebSocketImpl
   * @param token
   */
  #connectAndConsume(WebSocketImpl: WebSocketFactory, token: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const url = this.#buildUrl(token)
      const socket = new WebSocketImpl(url) as unknown as RawSocket
      this.#activeSocket = socket

      let opened = false
      let settled = false
      let pingTimer: ReturnType<typeof setInterval> | undefined
      let pongTimer: ReturnType<typeof setTimeout> | undefined

      const clearTimers = (): void => {
        if (pingTimer)
          clearInterval(pingTimer)
        if (pongTimer)
          clearTimeout(pongTimer)
      }

      const settle = (): void => {
        if (settled)
          return
        settled = true
        clearTimers()
        try {
          socket.removeAllListeners?.()
        } catch {
          // ignore
        }
        if (this.#activeSocket === socket)
          this.#activeSocket = null
        resolve(opened)
      }

      const startKeepAlive = (): void => {
        if (typeof socket.ping !== 'function')
          return // native WebSocket cannot send client pings; rely on reconnect
        pingTimer = setInterval(() => {
          if (pongTimer)
            clearTimeout(pongTimer)
          pongTimer = setTimeout(() => {
            this.#logger.warn('pong timeout — treating socket as dead')
            this.#terminate(socket)
          }, this.#config.resilience.pongTimeoutMs)
          pongTimer.unref?.()
          try {
            socket.ping?.()
          } catch {
            this.#terminate(socket)
          }
        }, this.#config.resilience.pingIntervalMs)
        pingTimer.unref?.()
      }

      bindSocket(socket, {
        open: () => {
          opened = true
          this.#logger.debug('consumer socket open')
          startKeepAlive()
        },
        message: (data) => {
          this.#onMessage(dataToString(data), socket)
        },
        pong: () => {
          if (pongTimer)
            clearTimeout(pongTimer)
        },
        close: () => {
          this.#logger.debug('consumer socket closed')
          settle()
        },
        error: (error) => {
          if (!this.#isClosing)
            this.#logger.debug('consumer socket error', error)
          settle()
        },
      })

      // Close was requested while the socket was still connecting.
      if (this.#isClosing)
        this.#terminate(socket)
    })
  }

  #onMessage(text: string, socket: RawSocket): void {
    const parsed = parseFrame(text)
    if (!parsed) {
      this.#logger.debug('skipping unparseable notification frame')
      return
    }

    let acked = false
    const notification: Notification = {
      ackHeader: parsed.ackHeader,
      description: parsed.description,
      action: parsed.action,
      extraHeaders: parsed.extraHeaders,
      payload: parsePayload(parsed.rawPayload),
      rawPayload: parsed.rawPayload,
      raw: text,
      ack: () => {
        if (acked)
          return
        acked = true
        try {
          // Acks must be sent on the same connection the message arrived on.
          socket.send(parsed.ackHeader)
        } catch (error) {
          this.#logger.debug('ack could not be sent (message will be redelivered)', error)
        }
      },
    }

    this.#push(notification)
  }

  #buildUrl(token: string): string {
    const httpUrl = joinPath(this.#config.baseUrl, 'notification2/consumer/')
    const wsUrl = httpUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://')
    const params = new URLSearchParams({ token })
    if (this.#config.consumerName)
      params.set('consumer', this.#config.consumerName)
    return `${wsUrl}?${params.toString()}`
  }

  #terminate(socket: RawSocket): void {
    try {
      if (typeof socket.terminate === 'function')
        socket.terminate()
      else
        socket.close()
    } catch {
      // ignore
    }
  }

  #finish(): void {
    this.#finished = true
    this.#flushWaiters()
    this.#resolveDone()
  }

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.#isClosing) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        this.#wakeDelay = undefined
        resolve()
      }, ms)
      // Allow close() to cut the wait short.
      this.#wakeDelay = () => {
        clearTimeout(timer)
        this.#wakeDelay = undefined
        resolve()
      }
      // Do not keep the event loop alive purely for a backoff timer.
      ;(timer as { unref?: () => void }).unref?.()
    })
  }
}

/**
 * A permanent HTTP client error (4xx other than 429) will not recover on retry.
 * @param error
 */
function isFatalHttpError(error: unknown): boolean {
  return error instanceof C8yHttpError
    && error.status >= 400
    && error.status < 500
    && error.status !== 429
}

// ── framework-agnostic socket helpers ────────────────────────────────────────

interface SocketHandlers {
  open: () => void
  message: (data: unknown) => void
  pong: () => void
  close: () => void
  error: (error: unknown) => void
}

/**
 * Bind handlers to a socket regardless of whether it exposes a Node
 * EventEmitter interface (`ws`) or the DOM interface (native `WebSocket`).
 * @param socket
 * @param handlers
 */
function bindSocket(socket: RawSocket, handlers: SocketHandlers): void {
  if (typeof socket.on === 'function') {
    socket.on('open', () => handlers.open())
    socket.on('message', (data?: unknown) => handlers.message(data))
    socket.on('pong', () => handlers.pong())
    socket.on('close', () => handlers.close())
    socket.on('error', (error?: unknown) => handlers.error(error))
    return
  }
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener('open', () => handlers.open())
    socket.addEventListener('message', (event) => handlers.message(event?.data))
    socket.addEventListener('close', () => handlers.close())
    socket.addEventListener('error', (event) => handlers.error(event))
    // Native WebSocket has no client-visible pong event.
    return
  }
  throw new C8yConnectionError('provided WebSocket implementation exposes neither on() nor addEventListener()')
}

/**
 * Coerce socket message payloads (string / Buffer / ArrayBuffer) to text.
 * @param data
 */
function dataToString(data: unknown): string {
  if (typeof data === 'string')
    return data
  if (data instanceof ArrayBuffer)
    return Buffer.from(data).toString('utf8')
  if (Array.isArray(data))
    return Buffer.concat(data as Uint8Array[]).toString('utf8')
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return String(data)
}

/**
 * Local URL join (kept dependency-free and independent of the REST helper).
 * @param baseUrl
 * @param path
 */
function joinPath(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`
  return `${withScheme}/${path.replace(/^\/+/, '')}`
}
