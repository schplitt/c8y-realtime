import type { RealtimeAuth } from './bayeux/auth'

export interface DeletionManageObject {
  id: string
}

export interface BasicManageObject {
  id: string
  name?: string
  /**
   * ISO 8601 timestamp of the last update
   */
  lastUpdated: string
  /**
    ISO 8601 timestamp of the creation time
   */
  creationTime: string

  [key: string]: any
}

export interface C8YBayeuxConnectionOptions {
  auth: RealtimeAuth
  url: string
  headers?: Record<string, string>
}

export type ManagedObjectSubscriptionTarget = '*' | (string & {})
export type InventorySubscriptionChannel = `/inventory/${ManagedObjectSubscriptionTarget}`
export type SubscriptionChannel = InventorySubscriptionChannel
export type BayeuxMessageConnectionTypes = 'websocket'

export interface FailedHandshake {
  channel: '/meta/handshake'
  error: string
  successful: false
}

export interface SuccessfulHandshake {
  channel: '/meta/handshake'
  clientId: string
  successful: true
  minimumVersion: string
  supportedConnectionTypes: BayeuxMessageConnectionTypes[]
  version: string
}

export type Handshake = SuccessfulHandshake | FailedHandshake

export interface HandshakeRequest {
  channel: '/meta/handshake'
  version: '1.0'
  supportedConnectionTypes: ['websocket']
  ext: Record<string, unknown>
}

export interface SubscribeRequest<TSubscription extends SubscriptionChannel> {
  channel: '/meta/subscribe'
  clientId: string
  subscription: TSubscription
}

export interface UnsubscribeRequest<TSubscription extends SubscriptionChannel> {
  channel: '/meta/unsubscribe'
  clientId: string
  subscription: TSubscription
}

export interface DisconnectRequest {
  channel: '/meta/disconnect'
  clientId: string
}

export interface FailedSubscribeResponse<TSubscription extends SubscriptionChannel> {
  channel: '/meta/subscribe'
  subscription: TSubscription
  successful: false
  error: string
}

export interface FailedUnsubscribeResponse<TSubscription extends SubscriptionChannel> {
  channel: '/meta/unsubscribe'
  subscription: TSubscription
  successful: false
  error: string
}

export interface SuccessfulSubscribeResponse<TSubscription extends SubscriptionChannel> {
  channel: '/meta/subscribe'
  subscription: TSubscription
  successful: true
}

export interface SuccessfulUnsubscribeResponse<TSubscription extends SubscriptionChannel> {
  channel: '/meta/unsubscribe'
  subscription: TSubscription
  successful: true
}

export interface FailedDisconnectResponse {
  channel: '/meta/disconnect'
  successful: false
  error: string
}

export interface SuccessfulDisconnectResponse {
  channel: '/meta/disconnect'
  successful: true
}

export type SubscribeResponse<TSubscription extends SubscriptionChannel> = SuccessfulSubscribeResponse<TSubscription>
  | FailedSubscribeResponse<TSubscription>

export type UnsubscribeResponse<TSubscription extends SubscriptionChannel> = SuccessfulUnsubscribeResponse<TSubscription>
  | FailedUnsubscribeResponse<TSubscription>

export type DisconnectResponse = SuccessfulDisconnectResponse | FailedDisconnectResponse

type C8YCallback<TData extends object> = (data: TData) => Promise<void> | void

interface InventoryHooks {
  'inventory:create': C8YCallback<BasicManageObject>
  'inventory:update': C8YCallback<BasicManageObject>
  'inventory:delete': C8YCallback<DeletionManageObject>
  'inventory:all': C8YCallback<BasicManageObject | DeletionManageObject>
}

export interface CumulocityHooks extends InventoryHooks {
}

export type CumulocityHookKey = keyof CumulocityHooks

export type HookCacheKey = `${string}#${keyof CumulocityHooks}`
