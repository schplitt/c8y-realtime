import { describe, expect, it, vi } from 'vitest'
import { HttpClient } from '../../src/http'
import { createToken, SubscriptionsApi } from '../../src/subscriptions'

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeApi(handler: (method: string, url: string, init: FetchInit) => Response) {
  const fetchImpl = vi.fn(async (url: string, init: FetchInit) =>
    handler(init.method ?? 'GET', url, init)) as unknown as typeof fetch
  const http = new HttpClient({ baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'p' }, fetchImpl)
  return { api: new SubscriptionsApi(http), http, fetchImpl }
}

describe('subscriptionsApi.ensure', () => {
  it('returns the created subscription on success', async () => {
    const { api } = makeApi((method) => {
      if (method === 'POST')
        return jsonResponse({ id: '1', context: 'tenant', subscription: 'demo' }, 201)
      throw new Error(`unexpected ${method}`)
    })

    const result = await api.ensure({ context: 'tenant', subscription: 'demo' })
    expect(result.id).toBe('1')
  })

  it('treats HTTP 409 as success and returns the existing subscription', async () => {
    const { api, fetchImpl } = makeApi((method) => {
      if (method === 'POST')
        return jsonResponse({ error: 'already exists' }, 409)
      // GET list lookup after the conflict
      return jsonResponse({ subscriptions: [{ id: '99', context: 'tenant', subscription: 'demo' }] })
    })

    const result = await api.ensure({ context: 'tenant', subscription: 'demo' })
    expect(result.id).toBe('99')
    // POST then GET
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('matches the existing subscription by name and source id', async () => {
    const { api } = makeApi((method) => {
      if (method === 'POST')
        return jsonResponse({}, 409)
      return jsonResponse({
        subscriptions: [
          { id: 'a', context: 'mo', subscription: 'demo', source: { id: '111' } },
          { id: 'b', context: 'mo', subscription: 'demo', source: { id: '222' } },
        ],
      })
    })

    const result = await api.ensure({ context: 'mo', subscription: 'demo', source: { id: '222' } })
    expect(result.id).toBe('b')
  })
})

describe('subscriptionsApi.ensureDetailed', () => {
  it('reports created: true for a fresh create and created: false after a 409', async () => {
    let conflict = false
    const { api } = makeApi((method) => {
      if (method === 'POST')
        return conflict ? jsonResponse({}, 409) : jsonResponse({ id: '1', context: 'tenant', subscription: 'demo' }, 201)
      return jsonResponse({ subscriptions: [{ id: '1', context: 'tenant', subscription: 'demo' }] })
    })
    const first = await api.ensureDetailed({ context: 'tenant', subscription: 'demo' })
    expect(first).toEqual({ created: true, subscription: { id: '1', context: 'tenant', subscription: 'demo' } })
    conflict = true
    const second = await api.ensureDetailed({ context: 'tenant', subscription: 'demo' })
    expect(second.created).toBe(false)
    expect(second.subscription.id).toBe('1')
  })
})

describe('subscriptionsApi.delete', () => {
  it('treats 404 as already-deleted success', async () => {
    const { api } = makeApi(() => new Response('', { status: 404 }))
    await expect(api.delete('missing')).resolves.toBeUndefined()
  })
})

describe('createToken', () => {
  it('posts token options and returns the token', async () => {
    let sentBody: unknown
    const fetchImpl = (async (_url: string, init: FetchInit) => {
      sentBody = JSON.parse(String(init.body))
      return jsonResponse({ token: 'jwt.value.here' })
    }) as unknown as typeof fetch
    const http = new HttpClient({ baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'p' }, fetchImpl)

    const { token } = await createToken(http, { subscription: 'demo', subscriber: 'svc', shared: true })
    expect(token).toBe('jwt.value.here')
    expect(sentBody).toMatchObject({ subscription: 'demo', subscriber: 'svc', shared: true })
  })
})
