import { describe, expect, it, vi } from 'vitest'
import { HttpClient } from '../../src/http'
import { C8yHttpError, C8ySubscriptionMismatchError } from '../../src/errors'
import { createToken, SubscriptionsApi } from '../../src/subscriptions'
import type { Subscription, SubscriptionResponse } from '../../src/types'

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

  it('adopts a tenant subscription whose source the platform filled in when the request has none', async () => {
    const existing: SubscriptionResponse = {
      id: '42',
      self: 'https://a.com/notification2/subscriptions/42',
      context: 'tenant',
      subscription: 'demo',
      source: { self: 'https://a.com/inventory/managedObjects/t123', id: 't123' } as SubscriptionResponse['source'],
      subscriptionFilter: { apis: ['alarms'] },
    }
    const { api } = makeApi((method) => method === 'POST'
      ? jsonResponse({ error: 'reliable-notification/Duplicate', message: 'Subscription demo already exists!' }, 409)
      : jsonResponse({ subscriptions: [existing] }))
    const result = await api.ensureDetailed({ context: 'tenant', subscription: 'demo', subscriptionFilter: { apis: ['alarms'] } })
    expect(result).toEqual({ created: false, subscription: existing })
    expect(result.subscription.id).toBe('42')
  })

  it('throws a plain 409 instead of returning the error body when no existing subscription matches', async () => {
    const errorBody = {
      error: 'reliable-notification/Duplicate',
      message: 'Subscription demo already exists!',
      info: 'https://example.com/docs',
    }
    const { api } = makeApi((method) => method === 'POST'
      ? jsonResponse(errorBody, 409)
      : jsonResponse({ subscriptions: [] }))
    const error = await api.ensureDetailed({ context: 'tenant', subscription: 'demo' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(C8yHttpError)
    expect((error as C8yHttpError).status).toBe(409)
  })
})

describe('subscriptionsApi.ensureDetailed — existing subscription mismatch', () => {
  const requested: Subscription = {
    context: 'mo',
    subscription: 'demo',
    source: { id: '1' },
    nonPersistent: false,
    subscriptionFilter: { apis: ['alarms', 'events'], typeFilter: '\'a\' or \'b\'' },
    fragmentsToCopy: ['c8y_A', 'c8y_B'],
  }

  function conflictWith(existing: SubscriptionResponse[]) {
    return makeApi((method) => method === 'POST' ? jsonResponse({}, 409) : jsonResponse({ subscriptions: existing })).api
  }

  it('returns a matching existing subscription with created: false', async () => {
    const existing = { id: 'x', ...requested }
    const result = await conflictWith([existing]).ensureDetailed(requested)
    expect(result).toEqual({ created: false, subscription: existing })
  })

  it('treats apis/fragmentsToCopy order and missing-vs-default values as equal', async () => {
    const existing: SubscriptionResponse = {
      id: 'x',
      context: 'mo',
      subscription: 'demo',
      source: { id: '1' },
      subscriptionFilter: { apis: ['events', 'alarms', 'alarms'], typeFilter: '\'a\' or \'b\'' },
      fragmentsToCopy: ['c8y_B', 'c8y_A'],
    }
    await expect(conflictWith([existing]).ensureDetailed(requested)).resolves.toMatchObject({ created: false })

    const bare: Subscription = { context: 'tenant', subscription: 'demo' }
    const explicitDefaults: SubscriptionResponse = {
      id: 'y',
      context: 'tenant',
      subscription: 'demo',
      nonPersistent: false,
      subscriptionFilter: { apis: [], typeFilter: '' },
      fragmentsToCopy: [],
    }
    await expect(conflictWith([explicitDefaults]).ensureDetailed(bare)).resolves.toMatchObject({ created: false })
    const { id: _id, ...explicitRequest } = explicitDefaults
    await expect(conflictWith([{ id: 'z', ...bare }]).ensureDetailed(explicitRequest)).resolves.toMatchObject({ created: false })
  })

  const differing: [string, Partial<Subscription>][] = [
    ['context', { context: 'tenant' }],
    ['nonPersistent', { nonPersistent: true }],
    ['apis', { subscriptionFilter: { apis: ['alarms'], typeFilter: '\'a\' or \'b\'' } }],
    ['typeFilter', { subscriptionFilter: { apis: ['alarms', 'events'], typeFilter: '\'a\'' } }],
    ['fragmentsToCopy', { fragmentsToCopy: ['c8y_A'] }],
  ]
  for (const [field, change] of differing) {
    it(`throws C8ySubscriptionMismatchError when ${field} differs`, async () => {
      const existing: SubscriptionResponse = { id: 'stale', ...requested, ...change }
      const error = await conflictWith([existing]).ensureDetailed(requested).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(C8ySubscriptionMismatchError)
      const mismatch = error as C8ySubscriptionMismatchError
      expect(mismatch.existing).toEqual(existing)
      expect(mismatch.requested).toEqual(requested)
      expect(mismatch.message).toContain('demo')
      expect(mismatch.message).toContain('stale')
      expect(mismatch.message).toContain(field)
    })
  }

  it('ensure() throws the same error', async () => {
    const existing: SubscriptionResponse = { id: 'stale', ...requested, nonPersistent: true }
    await expect(conflictWith([existing]).ensure(requested)).rejects.toBeInstanceOf(C8ySubscriptionMismatchError)
  })

  it('does not adopt or blame a same-name subscription with a different source: plain 409', async () => {
    const existing: SubscriptionResponse = { id: 'other', ...requested, source: { id: '999' } }
    const { api } = makeApi((method) => method === 'POST' ? new Response('', { status: 409 }) : jsonResponse({ subscriptions: [existing] }))
    const error = await api.ensureDetailed(requested).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(C8ySubscriptionMismatchError)
    expect(error).toBeInstanceOf(C8yHttpError)
    expect((error as C8yHttpError).status).toBe(409)
  })

  it('does not adopt another device\'s mo subscription for a source-less mo request: plain 409', async () => {
    const existing: SubscriptionResponse = { id: 'other', context: 'mo', subscription: 'demo', source: { id: '999' } }
    const { api } = makeApi((method) => method === 'POST' ? new Response('', { status: 409 }) : jsonResponse({ subscriptions: [existing] }))
    const error = await api.ensureDetailed({ context: 'mo', subscription: 'demo' }).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(C8ySubscriptionMismatchError)
    expect(error).toBeInstanceOf(C8yHttpError)
    expect((error as C8yHttpError).status).toBe(409)
  })

  it('blames a differing setting, not the platform-filled source, for a source-less tenant request', async () => {
    const existing: SubscriptionResponse = {
      id: 'stale',
      context: 'tenant',
      subscription: 'demo',
      source: { id: 't123' },
      nonPersistent: true,
    }
    const error = await conflictWith([existing]).ensureDetailed({ context: 'tenant', subscription: 'demo' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(C8ySubscriptionMismatchError)
    const { message } = error as C8ySubscriptionMismatchError
    expect(message).toContain('nonPersistent')
    expect(message).not.toContain('source')
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
