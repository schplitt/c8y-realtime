/**
 * Cumulocity domain payload types for the high-level, typed realtime API.
 *
 * These model the JSON payloads carried by Notification 2.0 frames for each
 * API. Every interface keeps an index signature so custom fragments remain
 * accessible while the well-known fields stay strongly typed.
 */

/**
 * Reference to a managed object (device / source).
 */
export interface SourceReference {
  id: string
  self?: string
  name?: string
}

/**
 * A managed object (inventory) payload.
 */
export interface ManagedObject {
  id: string
  name?: string
  type?: string
  owner?: string
  self?: string
  creationTime?: string
  lastUpdated?: string
  c8y_IsDevice?: Record<string, unknown>
  [fragment: string]: unknown
}

/**
 * A measurement payload.
 */
export interface Measurement {
  id: string
  source: SourceReference
  type: string
  time: string
  self?: string
  [fragment: string]: unknown
}

/**
 * An event payload.
 */
export interface C8yEvent {
  id: string
  source: SourceReference
  type: string
  text: string
  time: string
  creationTime?: string
  lastUpdated?: string
  self?: string
  [fragment: string]: unknown
}

/**
 * Alarm severity values.
 */
export type AlarmSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING'
/**
 * Alarm status values.
 */
export type AlarmStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'CLEARED'

/**
 * An alarm payload.
 */
export interface Alarm {
  id: string
  source: SourceReference
  type: string
  text: string
  severity: AlarmSeverity
  status: AlarmStatus
  time: string
  creationTime?: string
  lastUpdated?: string
  count?: number
  self?: string
  [fragment: string]: unknown
}

/**
 * Operation status values.
 */
export type OperationStatus = 'PENDING' | 'EXECUTING' | 'SUCCESSFUL' | 'FAILED'

/**
 * A device-control operation payload.
 */
export interface Operation {
  id: string
  deviceId: string
  status: OperationStatus
  creationTime?: string
  self?: string
  [fragment: string]: unknown
}

/**
 * The payload of a DELETE notification — typically only the id is present.
 */
export interface DeletionPayload {
  id: string
  [fragment: string]: unknown
}

/**
 * Maps a Notification 2.0 API/type string to its (non-delete) payload type.
 * `alarmsWithChildren` / `eventsWithChildren` carry the same shapes as their
 * base types.
 */
export interface NotificationPayloadMap {
  alarms: Alarm
  alarmsWithChildren: Alarm
  events: C8yEvent
  eventsWithChildren: C8yEvent
  measurements: Measurement
  managedobjects: ManagedObject
  operations: Operation
}

/**
 * The set of notification type strings that carry a typed payload.
 */
export type NotificationTypeName = keyof NotificationPayloadMap

/**
 * Friendly (lower-case) action names used by the high-level hook API.
 */
export type HookActionName = 'create' | 'update' | 'delete'

/**
 * Payload type for a given `<type>:<action>` combination — `DeletionPayload`
 * for deletes, the mapped domain type otherwise.
 */
export type HookPayload<
  Type extends NotificationTypeName,
  Action extends HookActionName,
> = Action extends 'delete' ? DeletionPayload : NotificationPayloadMap[Type]
