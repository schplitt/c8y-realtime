/**
 * A controllable mock WebSocket exposing the `ws`-style EventEmitter surface.
 */
export class MockSocket {
  static instances: MockSocket[] = []
  static reset(): void {
    MockSocket.instances = []
  }

  readonly url: string
  readonly sent: string[] = []
  pings = 0
  closedWith: number | undefined
  terminated = false
  #listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  constructor(url: string) {
    this.url = url
    MockSocket.instances.push(this)
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.#listeners.get(event) ?? []
    list.push(listener)
    this.#listeners.set(event, list)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? [])
      listener(...args)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  ping(): void {
    this.pings += 1
  }

  close(code?: number): void {
    this.closedWith = code
    queueMicrotask(() => this.emit('close'))
  }

  terminate(): void {
    this.terminated = true
    queueMicrotask(() => this.emit('close'))
  }

  removeAllListeners(): void {
    this.#listeners.clear()
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs)
      throw new Error('waitFor timed out')
    await delay(2)
  }
}
