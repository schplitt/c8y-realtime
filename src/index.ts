import { HookableCore } from 'hookable'
import type { CumulocityHooks, HookCacheKey } from './types'

export type {
  DeletionManageObject,
  BasicManageObject,
  CumulocityHooks,
  CumulocityHookKey,
} from './types'

export class RealtimeClient {
  #hooks = new HookableCore()

  hook<NameT extends keyof CumulocityHooks>(
    id: '*' | (string & {}),
    name: NameT,
    fn: CumulocityHooks[NameT],
  ): () => void {
    const key = this.#createHookKey(id, name)
    this.#hooks.hook(key, fn)
    return () => {
      this.#hooks.removeHook(key, fn)
    }
  }

  removeHook<TName extends keyof CumulocityHooks>(id: '*' | (string & {}), name: TName, fn: CumulocityHooks[TName]): void {
    const key = this.#createHookKey(id, name)
    this.#hooks.removeHook(key, fn)
  }

  removeHooks(name: keyof CumulocityHooks): void {
    const keysWithName = Object.entries(this.#hooks['_hooks'])
      .filter(([key]) => key.endsWith(`#${name}`))

    for (const [key, callback] of keysWithName) {
      if (callback) {
        for (const fn of callback) {
          this.#hooks.removeHook(key, fn)
        }
      }
    }
  }

  /**
   * Creates a unique hook key based on the id and name.
   * @param id - The id of the object or '*' to match all.
   * @param name - The name of the hook.
   * @returns The unique hook key in the format 'id#name', where name is <scope>:<action>. (id#<scope>:<action>)
   */
  #createHookKey<NameT extends keyof CumulocityHooks>(
    id: '*' | (string & {}),
    name: NameT,
  ): HookCacheKey {
    return `${id}#${name}`
  }
}
