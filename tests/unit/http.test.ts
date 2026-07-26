import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { C8yHttpError } from '../../src/errors'
import { basicAuthHeader, HttpClient, joinUrl, normalizeBaseUrl, toWebSocketUrl } from '../../src/http'

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>

describe('basicAuthHeader', () => {
  it('formats the tenant-qualified basic auth header', () => {
    const header = basicAuthHeader('t123', 'admin', 'secret')
    expect(header).toBe(`Basic ${Buffer.from('t123/admin:secret').toString('base64')}`)
  })

  it('encodes credentials with special characters', () => {
    const header = basicAuthHeader('t1', 'user@x', 'p:@ss word')
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8')
    expect(decoded).toBe('t1/user@x:p:@ss word')
  })
})

describe('normalizeBaseUrl', () => {
  it('adds https when scheme is missing', () => {
    expect(normalizeBaseUrl('mytenant.cumulocity.com')).toBe('https://mytenant.cumulocity.com')
  })

  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://a.com///')).toBe('https://a.com')
  })

  it('preserves an existing http scheme', () => {
    expect(normalizeBaseUrl('http://localhost:8080/')).toBe('http://localhost:8080')
  })
})

describe('joinUrl', () => {
  it('joins base and path tolerating slashes', () => {
    expect(joinUrl('https://a.com/', '/notification2/token')).toBe('https://a.com/notification2/token')
    expect(joinUrl('https://a.com', 'notification2/token')).toBe('https://a.com/notification2/token')
  })
})

describe('toWebSocketUrl', () => {
  it('maps https to wss and http to ws', () => {
    expect(toWebSocketUrl('https://a.com', 'notification2/consumer/')).toBe('wss://a.com/notification2/consumer/')
    expect(toWebSocketUrl('http://localhost', 'notification2/consumer/')).toBe('ws://localhost/notification2/consumer/')
  })

  it('assumes wss for a bare host', () => {
    expect(toWebSocketUrl('a.com', 'notification2/consumer/')).toBe('wss://a.com/notification2/consumer/')
  })
})

describe('httpClient error typing', () => {
  it('throws a typed C8yHttpError carrying the status', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'nope' }), {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    const http = new HttpClient({ baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'sup3rSecretPw' }, fetchImpl)

    await expect(http.request('GET', 'notification2/subscriptions')).rejects.toMatchObject({
      status: 403,
    })
    await http.request('GET', 'x').catch((error: unknown) => {
      expect(error).toBeInstanceOf(C8yHttpError)
      if (error instanceof C8yHttpError) {
        expect(error.status).toBe(403)
        expect(error.body).toEqual({ error: 'nope' })
        expect(error.url).not.toContain('sup3rSecretPw') // never leaks the password
      }
    })
  })

  it('sends the Authorization header and JSON content type', async () => {
    let seenHeaders: Headers | undefined
    const fetchImpl = (async (_url: string, init: FetchInit) => {
      seenHeaders = new Headers(init.headers)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const http = new HttpClient({ baseUrl: 'https://a.com', tenant: 't', user: 'u', password: 'p' }, fetchImpl)
    await http.request('POST', 'notification2/token', { body: { a: 1 } })

    expect(seenHeaders?.get('authorization')).toBe(basicAuthHeader('t', 'u', 'p'))
    expect(seenHeaders?.get('content-type')).toBe('application/json')
  })
})
