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
