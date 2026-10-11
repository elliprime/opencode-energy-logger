import { debug } from './log.js'

/** Storage surface the toggle state persists through. */
export interface ToggleStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: boolean): Promise<void>
}

export interface ToggleStore {
  enabled(): boolean
  toggle(): Promise<boolean>
}

export async function toggleStore(
  input: {
    defaultEnabled: boolean
    directory: string
    storage: ToggleStorage
  },
): Promise<ToggleStore> {
  const { defaultEnabled, directory, storage } = input
  const storageKey = `directory:${directory}`
  let current = defaultEnabled

  try {
    const stored = await storage.get(storageKey)
    if (typeof stored === 'boolean') {
      current = stored
    }
  } catch (error) {
    debug(`toggle state hydration failed: ${String(error)}`)
  }

  return {
    enabled: () => current,
    toggle: async () => {
      const previous = current
      current = !current

      try {
        await storage.set(storageKey, current)
      } catch (error) {
        // saving failed, so revert the change to the in memory value
        current = previous
        debug(`toggle state persist failed: ${String(error)}`)
        throw error
      }

      return current
    },
  }
}
