import type {
  BayeuxMessageConnectionTypes,
  DisconnectResponse,
  Handshake,
  InventorySubscriptionChannel,
  SubscribeResponse,
  UnsubscribeResponse,
} from '../types'

export function parseHandshake(response: unknown): Handshake {
  if (!Array.isArray(response) || response.length === 0) {
    throw new Error('Invalid Bayeux handshake response.')
  }

  const [message] = response

  if (!message || typeof message !== 'object') {
    throw new Error('Invalid Bayeux handshake response.')
  }

  if (message.channel !== '/meta/handshake' || typeof message.successful !== 'boolean') {
    throw new Error('Expected a /meta/handshake response.')
  }

  if (message.successful) {
    if (
      typeof message.clientId !== 'string'
      || typeof message.minimumVersion !== 'string'
      || !Array.isArray(message.supportedConnectionTypes)
      || typeof message.version !== 'string'
    ) {
      throw new Error('Invalid successful Bayeux handshake response.')
    }

    return {
      channel: '/meta/handshake',
      clientId: message.clientId,
      successful: true,
      minimumVersion: message.minimumVersion,
      supportedConnectionTypes: message.supportedConnectionTypes as BayeuxMessageConnectionTypes[],
      version: message.version,
    }
  }

  if (typeof message.error !== 'string') {
    throw new Error('Invalid failed Bayeux handshake response.')
  }

  return {
    channel: '/meta/handshake',
    error: message.error,
    successful: false,
  }
}

export function parseSubscribeResponse(
  response: unknown,
  expectedSubscription: InventorySubscriptionChannel,
): SubscribeResponse<InventorySubscriptionChannel> | null {
  if (!Array.isArray(response) || response.length === 0) {
    throw new Error('Invalid Bayeux /meta/subscribe response.')
  }

  for (const message of response) {
    if (!message || typeof message !== 'object') {
      continue
    }

    if (message.channel !== '/meta/subscribe' || message.subscription !== expectedSubscription) {
      continue
    }

    if (typeof message.successful !== 'boolean') {
      throw new Error('Invalid Bayeux /meta/subscribe response.')
    }

    if (message.successful) {
      return {
        channel: '/meta/subscribe',
        subscription: expectedSubscription,
        successful: true,
      }
    }

    if (typeof message.error !== 'string') {
      throw new Error('Invalid failed Bayeux /meta/subscribe response.')
    }

    return {
      channel: '/meta/subscribe',
      subscription: expectedSubscription,
      successful: false,
      error: message.error,
    }
  }

  return null
}

export function parseUnsubscribeResponse(
  response: unknown,
  expectedSubscription: InventorySubscriptionChannel,
): UnsubscribeResponse<InventorySubscriptionChannel> | null {
  if (!Array.isArray(response) || response.length === 0) {
    throw new Error('Invalid Bayeux /meta/unsubscribe response.')
  }

  for (const message of response) {
    if (!message || typeof message !== 'object') {
      continue
    }

    if (message.channel !== '/meta/unsubscribe' || message.subscription !== expectedSubscription) {
      continue
    }

    if (typeof message.successful !== 'boolean') {
      throw new Error('Invalid Bayeux /meta/unsubscribe response.')
    }

    if (message.successful) {
      return {
        channel: '/meta/unsubscribe',
        subscription: expectedSubscription,
        successful: true,
      }
    }

    if (typeof message.error !== 'string') {
      throw new Error('Invalid failed Bayeux /meta/unsubscribe response.')
    }

    return {
      channel: '/meta/unsubscribe',
      subscription: expectedSubscription,
      successful: false,
      error: message.error,
    }
  }

  return null
}

export function parseDisconnectResponse(response: unknown): DisconnectResponse | null {
  if (!Array.isArray(response) || response.length === 0) {
    throw new Error('Invalid Bayeux /meta/disconnect response.')
  }

  for (const message of response) {
    if (!message || typeof message !== 'object') {
      continue
    }

    if (message.channel !== '/meta/disconnect') {
      continue
    }

    if (typeof message.successful !== 'boolean') {
      throw new Error('Invalid Bayeux /meta/disconnect response.')
    }

    if (message.successful) {
      return {
        channel: '/meta/disconnect',
        successful: true,
      }
    }

    if (typeof message.error !== 'string') {
      throw new Error('Invalid failed Bayeux /meta/disconnect response.')
    }

    return {
      channel: '/meta/disconnect',
      successful: false,
      error: message.error,
    }
  }

  return null
}
