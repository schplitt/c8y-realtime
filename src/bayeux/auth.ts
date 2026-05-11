import { Buffer } from 'node:buffer'

export interface RealtimeAuth {
  type: 'basic'
  tenant: string
  user: string
  password: string
}

/**
 * Creates the Base64 token Cumulocity expects in
 * `ext.com.cumulocity.authn.token` for Bayeux websocket handshakes.
 *
 * @param auth - Required Cumulocity basic auth credentials.
 */
export function createBasicAuthToken(auth: RealtimeAuth): string {
  return Buffer.from(`${auth.tenant}/${auth.user}:${auth.password}`, 'utf8').toString('base64')
}

export function createHandshakeExt(auth: RealtimeAuth): Record<string, unknown> {
  return {
    'com.cumulocity.authn': {
      token: createBasicAuthToken(auth),
    },
  }
}
