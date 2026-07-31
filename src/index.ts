/**
 * c8y-realtime — a standalone, dependency-light TypeScript SDK for the
 * Cumulocity IoT Notification 2.0 API.
 *
 * Zero dependency on `@c8y/client`. Native `fetch` for REST and `ws` (or the
 * native `WebSocket`) for the consumer. ESM only, strict TypeScript.
 *
 * @example Single tenant
 * ```ts
 * import { createNotificationClient, SubscriptionApis } from 'c8y-realtime'
 *
 * const client = createNotificationClient({ baseUrl, tenant, user, password })
 *
 * await client.subscriptions.ensure({
 *   context: 'tenant',
 *   subscription: 'my-devices',
 *   subscriptionFilter: { apis: [SubscriptionApis.measurements] },
 * })
 *
 * const consumer = client.subscribe('my-devices', { subscriber: 'my-service' })
 * for await (const notification of consumer) {
 *   console.log(notification.action, notification.description.type, notification.payload)
 *   break // auto-ack applies once processing finishes
 * }
 * await client.close()
 * ```
 */

export { createNotificationClient, NotificationClient } from './client'
export { WebSocketConsumer } from './consumer'
export { C8yConnectionError, C8yError, C8yHttpError } from './errors'
export { parseDescription, parseFrame, parsePayload } from './frame'
export { basicAuthHeader, joinUrl, normalizeBaseUrl, toWebSocketUrl } from './http'
export { createRealtimeClient, RealtimeClient } from './realtime'
export { createToken, SubscriptionsApi, unsubscribeConsumer } from './subscriptions'
export { SubscriptionApis } from './types'

export type { ConsumerConfig } from './consumer'
export type {
  Alarm,
  AlarmSeverity,
  AlarmStatus,
  C8yEvent,
  DeletionPayload,
  HookActionName,
  HookPayload,
  ManagedObject,
  Measurement,
  NotificationPayloadMap,
  NotificationTypeName,
  Operation,
  OperationStatus,
  SourceReference,
} from './domain'
export type { ParsedFrame } from './frame'
export type {
  AllRegister,
  AnyRegister,
  HookKeyPayload,
  IdRegister,
  ManagedObjectHooks,
  MeasurementHooks,
  NotificationHandler,
  RealtimeClientOptions,
  RealtimeHookKey,
  RealtimeSubscriptionOptions,
  TypeHooks,
  UnhookResult,
  Unsubscribe,
  UnsubscribeResult,
} from './realtime'
export type {
  ConsumerResilienceOptions,
  Logger,
  Notification,
  NotificationClientOptions,
  NotificationDescription,
  NotificationTokenOptions,
  SubscribeOptions,
  Subscription,
  SubscriptionApi,
  SubscriptionCollection,
  SubscriptionContext,
  SubscriptionFilter,
  SubscriptionListFilter,
  SubscriptionResponse,
  SubscriptionSource,
  TenantCredentials,
  TokenResponse,
  WebSocketFactory,
  WebSocketInstanceLike,
} from './types'
