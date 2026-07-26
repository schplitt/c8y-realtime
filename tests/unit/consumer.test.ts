import { describe, expect, it, vi } from 'vitest'
import { WebSocketConsumer } from '../../src/consumer'
import { C8yHttpError } from '../../src/errors'
import { delay, MockSocket, waitFor } from './mock-socket'
import type { ConsumerConfig } from '../../src/consumer'
import type { Logger, WebSocketFactory } from '../../src/types'

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function makeConsumer(overrides: Partial<ConsumerConfig> = {}): WebSocketConsumer {
  const config: ConsumerConfig = {
    baseUrl: 'https://a.com',
    autoAck: true,
    resilience: { pingIntervalMs: 10_000, pongTimeoutMs: 10_000, initialBackoffMs: 2, maxBackoffMs: 8 },
    logger: silentLogger,
    mintToken: vi.fn(async () => 'test-token'),
    getWebSocket: async () => MockSocket as unknown as WebSocketFactory,
    ...overrides,
  }
  return new WebSocketConsumer(config)
}

const FRAME = ['ACKID123', '/t1/measurements/42', 'CREATE', '', '{"value":1}'].join('\n')

describe('webSocketConsumer connection lifecycle', () => {
  it('builds the wss consumer URL with the token', async () => {
    MockSocket.reset()
    const consumer = makeConsumer()
    await waitFor(() => MockSocket.instances.length >= 1)
    expect(MockSocket.instances[0]?.url).toBe('wss://a.com/notification2/consumer/?token=test-token')
    await consumer.close()
  })

  it('mints a fresh token for every connection (token refresh)', async () => {
    MockSocket.reset()
    const mintToken = vi.fn(async () => 'tok')
    const consumer = makeConsumer({ mintToken })
    await waitFor(() => MockSocket.instances.length >= 1)
    MockSocket.instances[0]?.emit('open')
    MockSocket.instances[0]?.emit('close') // unexpected drop -> reconnect
    await waitFor(() => MockSocket.instances.length >= 2)
    expect(mintToken.mock.calls.length).toBeGreaterThanOrEqual(2)
    await consumer.close()
  })

  it('reconnects after an unexpected close (backoff)', async () => {
    MockSocket.reset()
    const consumer = makeConsumer()
    await waitFor(() => MockSocket.instances.length >= 1)
    MockSocket.instances[0]?.emit('open')
    MockSocket.instances[0]?.emit('close')
    await waitFor(() => MockSocket.instances.length >= 2)
    expect(MockSocket.instances.length).toBeGreaterThanOrEqual(2)
    await consumer.close()
  })

  it('stops without retrying on a fatal 4xx from token mint', async () => {
    MockSocket.reset()
    const mintToken = vi.fn(async () => {
      throw new C8yHttpError({ status: 422, statusText: 'Unprocessable Entity', url: 'token', body: undefined, method: 'POST' })
    })
    const consumer = makeConsumer({ mintToken })
    // A permanent client error must end the consumer, not loop forever.
    await consumer.closed
    expect(mintToken).toHaveBeenCalledTimes(1)
    expect(MockSocket.instances.length).toBe(0) // never opened a socket
  })

  it('does not reconnect after an intentional close (teardown flag)', async () => {
    MockSocket.reset()
    const consumer = makeConsumer()
    await waitFor(() => MockSocket.instances.length >= 1)
    const first = MockSocket.instances[0]!
    first.emit('open')
    await consumer.close()
    expect(first.closedWith).toBe(1000)
    // Give any erroneous reconnect a chance to happen, then assert none did.
    await delay(30)
    expect(MockSocket.instances.length).toBe(1)
  })

  it('does not surface errors emitted during teardown', async () => {
    MockSocket.reset()
    const errorLog = vi.fn()
    const consumer = makeConsumer({ logger: { ...silentLogger, debug: errorLog } })
    await waitFor(() => MockSocket.instances.length >= 1)
    const first = MockSocket.instances[0]!
    first.emit('open')
    const closing = consumer.close()
    first.emit('error', new Error('boom during teardown'))
    await closing
    // The consumer stops cleanly; no reconnect socket is created.
    await delay(20)
    expect(MockSocket.instances.length).toBe(1)
  })
})

describe('webSocketConsumer acknowledgements', () => {
  it('supports explicit ack with autoAck disabled', async () => {
    MockSocket.reset()
    const consumer = makeConsumer({ autoAck: false })
    await waitFor(() => MockSocket.instances.length >= 1)
    const socket = MockSocket.instances[0]!
    socket.emit('open')
    socket.emit('message', FRAME)

    const iterator = consumer[Symbol.asyncIterator]()
    const { value, done } = await iterator.next()
    expect(done).toBe(false)
    expect(value?.ackHeader).toBe('ACKID123')
    expect(value?.payload).toEqual({ value: 1 })
    expect(socket.sent).toEqual([]) // not acked yet

    value!.ack()
    expect(socket.sent).toEqual(['ACKID123'])
    value!.ack() // idempotent
    expect(socket.sent).toEqual(['ACKID123'])

    await consumer.close()
  })

  it('auto-acks after the consumer finishes processing', async () => {
    MockSocket.reset()
    const consumer = makeConsumer({ autoAck: true })
    await waitFor(() => MockSocket.instances.length >= 1)
    const socket = MockSocket.instances[0]!
    socket.emit('open')
    socket.emit('message', FRAME)

    const iterator = consumer[Symbol.asyncIterator]()
    const { value } = await iterator.next()
    expect(value?.ackHeader).toBe('ACKID123')
    // Not acked until processing of this item completes.
    expect(socket.sent).toEqual([])

    // Ending iteration (break) triggers auto-ack of the last delivered item.
    await iterator.return?.()
    expect(socket.sent).toEqual(['ACKID123'])
  })

  it('skips unparseable frames without crashing', async () => {
    MockSocket.reset()
    const consumer = makeConsumer({ autoAck: false })
    await waitFor(() => MockSocket.instances.length >= 1)
    const socket = MockSocket.instances[0]!
    socket.emit('open')
    socket.emit('message', '') // no ack header -> skipped
    socket.emit('message', FRAME)

    const iterator = consumer[Symbol.asyncIterator]()
    const { value } = await iterator.next()
    expect(value?.ackHeader).toBe('ACKID123')
    await consumer.close()
  })
})
