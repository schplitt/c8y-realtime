import { createHandshakeExt } from './auth'
import type { RealtimeAuth } from './auth'
import type {
  DisconnectRequest,
  HandshakeRequest,
  SubscribeRequest,
  SubscriptionChannel,
  UnsubscribeRequest,
} from '../types'

export function createHandshakeRequest(auth: RealtimeAuth): [HandshakeRequest] {
  return [{
    channel: '/meta/handshake',
    version: '1.0',
    supportedConnectionTypes: ['websocket'],
    ext: createHandshakeExt(auth),
  }]
}

export function createSubscribeRequest<TSubscription extends SubscriptionChannel>(
  clientId: string,
  subscription: TSubscription,
): [SubscribeRequest<TSubscription>] {
  return [{
    channel: '/meta/subscribe',
    clientId,
    subscription,
  }]
}

export function createUnsubscribeRequest<TSubscription extends SubscriptionChannel>(
  clientId: string,
  subscription: TSubscription,
): [UnsubscribeRequest<TSubscription>] {
  return [{
    channel: '/meta/unsubscribe',
    clientId,
    subscription,
  }]
}

export function createDisconnectRequest(clientId: string): [DisconnectRequest] {
  return [{
    channel: '/meta/disconnect',
    clientId,
  }]
}
