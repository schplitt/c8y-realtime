import type { RealtimeAuth } from './auth'
import {
  createDisconnectRequest,
  createHandshakeRequest,
  createSubscribeRequest,
  createUnsubscribeRequest,
} from './messages'
import {
  parseDisconnectResponse,
  parseHandshake,
  parseSubscribeResponse,
  parseUnsubscribeResponse,
} from './parse'
import type {
  C8YBayeuxConnectionOptions,
  DisconnectResponse,
  Handshake,
  InventorySubscriptionChannel,
  SubscriptionChannel,
  SubscribeResponse,
  SuccessfulHandshake,
  UnsubscribeResponse,
} from '../types'

interface WaitForMessageOptions<TResult> {
  parse: (payload: unknown) => TResult | null
  errorMessage: string
  closeMessage: string
}

export type { C8YBayeuxConnectionOptions } from '../types'

export class C8YBayeuxConnection {
  readonly auth: RealtimeAuth
  readonly url: string
  readonly headers?: Record<string, string>

  #ws: WebSocket | null = null
  #connectionState: Handshake | Promise<Handshake> | null = null
  #subscriptions = new Set<SubscriptionChannel>()

  constructor(options: C8YBayeuxConnectionOptions) {
    // add the /notification/realtime path if not included in the URL, as this is required for Cumulocity
    if (!options.url.endsWith('/notification/realtime')) {
      options.url = `${options.url.replace(/\/+$/, '')}/notification/realtime`
    }
    this.auth = options.auth
    this.url = options.url
    this.headers = options.headers
  }

  get isConnected(): Promise<boolean> {
    return (async () => !!(await this.#connectionState)?.successful)()
  }

  async subscribe(channel: InventorySubscriptionChannel): Promise<void> {
    const { clientId } = await this.#connect()
    const ws = this.#getOrCreateWebSocket()
    const responsePromise = this.#waitForMessage<SubscribeResponse<InventorySubscriptionChannel>>(ws, {
      parse: (payload) => parseSubscribeResponse(payload, channel),
      errorMessage: 'WebSocket error while waiting for /meta/subscribe response.',
      closeMessage: 'WebSocket closed while waiting for /meta/subscribe response.',
    })

    ws.send(JSON.stringify(createSubscribeRequest(clientId, channel)))

    const response = await responsePromise

    if (!response.successful) {
      throw new Error(response.error)
    }

    this.#subscriptions.add(channel)
  }

  async unsubscribe(channel: InventorySubscriptionChannel): Promise<void> {
    const handshake = await this.#connectionState

    if (!handshake?.successful) {
      return
    }

    const ws = this.#getOrCreateWebSocket()
    const responsePromise = this.#waitForMessage<UnsubscribeResponse<InventorySubscriptionChannel>>(ws, {
      parse: (payload) => parseUnsubscribeResponse(payload, channel),
      errorMessage: 'WebSocket error while waiting for /meta/unsubscribe response.',
      closeMessage: 'WebSocket closed while waiting for /meta/unsubscribe response.',
    })

    ws.send(JSON.stringify(createUnsubscribeRequest(handshake.clientId, channel)))

    const response = await responsePromise

    if (!response.successful) {
      throw new Error(response.error)
    }

    this.#subscriptions.delete(channel)
  }

  async disconnect(): Promise<void> {
    const handshake = await this.#connectionState
    const ws = this.#ws

    this.#subscriptions.clear()
    this.#connectionState = null
    this.#ws = null

    if (!handshake?.successful || !ws || ws.readyState !== WebSocket.OPEN) {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close()
      }
      return
    }

    const responsePromise = this.#waitForMessage<DisconnectResponse>(ws, {
      parse: parseDisconnectResponse,
      errorMessage: 'WebSocket error while waiting for /meta/disconnect response.',
      closeMessage: 'WebSocket closed while waiting for /meta/disconnect response.',
    })

    ws.send(JSON.stringify(createDisconnectRequest(handshake.clientId)))

    const response = await responsePromise

    if (!response.successful) {
      throw new Error(response.error)
    }

    ws.close()
  }

  #getOrCreateWebSocket(): WebSocket {
    if (this.#ws && this.#ws.readyState !== WebSocket.CLOSED) {
      return this.#ws
    }

    this.#ws = new WebSocket(this.url)
    return this.#ws
  }

  async #connect(): Promise<SuccessfulHandshake> {
    if (this.#connectionState) {
      return Promise.resolve(this.#connectionState).then((handshake) => {
        if (!handshake.successful) {
          throw new Error(handshake.error)
        }

        return handshake
      })
    }

    const handshakePromise = this.#performHandshake()
      .then((handshake) => {
        this.#connectionState = handshake
        return handshake
      })
      .catch((error: unknown) => {
        this.#connectionState = null
        throw error
      })

    this.#connectionState = handshakePromise

    return handshakePromise
  }

  async #performHandshake(): Promise<SuccessfulHandshake> {
    const ws = this.#getOrCreateWebSocket()
    const handshakeResponsePromise = this.#waitForMessage<Handshake>(ws, {
      parse: parseHandshake,
      errorMessage: 'WebSocket error while waiting for handshake response.',
      closeMessage: 'WebSocket closed while waiting for handshake response.',
    })

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(createHandshakeRequest(this.auth)))
    } else {
      await new Promise<void>((resolve, reject) => {
        let handleOpen: () => void = () => {}
        let handleError: (e: unknown) => void = () => {}
        let handleClose: () => void = () => {}

        const cleanup = () => {
          ws.removeEventListener('open', handleOpen)
          ws.removeEventListener('error', handleError)
          ws.removeEventListener('close', handleClose)
        }

        handleOpen = () => {
          cleanup()
          ws.send(JSON.stringify(createHandshakeRequest(this.auth)))
          resolve()
        }

        handleError = (e) => {
          cleanup()
          reject(new Error('WebSocket error before handshake.', { cause: e }))
        }

        handleClose = () => {
          cleanup()
          reject(new Error('WebSocket closed before handshake.'))
        }

        ws.addEventListener('open', handleOpen)
        ws.addEventListener('error', handleError)
        ws.addEventListener('close', handleClose)
      })
    }

    const handshake = await handshakeResponsePromise

    if (!handshake.successful) {
      throw new Error(handshake.error)
    }

    if (!handshake.supportedConnectionTypes.includes('websocket')) {
      throw new Error('Server does not support the websocket transport.')
    }

    return handshake
  }

  #waitForMessage<TResult>(ws: WebSocket, options: WaitForMessageOptions<TResult>): Promise<TResult> {
    return new Promise((resolve, reject) => {
      let handleMessage: (event: MessageEvent) => Promise<void> = async () => {}
      let handleError: (e: unknown) => void = () => {}
      let handleClose: () => void = () => {}

      const cleanup = () => {
        ws.removeEventListener('message', handleMessage)
        ws.removeEventListener('error', handleError)
        ws.removeEventListener('close', handleClose)
      }

      handleMessage = async (event: MessageEvent) => {
        try {
          const payload = await this.#readMessageData(event.data)
          const result = options.parse(JSON.parse(payload) as unknown)

          if (result === null) {
            return
          }

          cleanup()
          resolve(result)
        } catch (error) {
          cleanup()
          reject(error)
        }
      }

      handleError = (e) => {
        console.error('WebSocket error:', e)
        cleanup()
        reject(new Error(options.errorMessage, { cause: e }))
      }

      handleClose = () => {
        cleanup()
        reject(new Error(options.closeMessage))
      }

      ws.addEventListener('message', handleMessage)
      ws.addEventListener('error', handleError)
      ws.addEventListener('close', handleClose)
    })
  }

  async #readMessageData(data: unknown): Promise<string> {
    if (typeof data === 'string') {
      return data
    }

    if (data instanceof Blob) {
      return await data.text()
    }

    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(data)
    }

    if (ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      )
    }

    return String(data)
  }
}
