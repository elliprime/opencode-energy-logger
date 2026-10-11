import { describe, expect, it } from 'vitest'
import { toggleStore } from '../src/toggle.store.js'

function makeStorage(initial?: Record<string, unknown>) {
  const data = new Map(Object.entries(initial ?? {}))
  return {
    data,
    get: async (key: string) => data.get(key),
    set: async (key: string, value: boolean) => {
      data.set(key, value)
    },
  }
}

describe('toggleStore', () => {
  it('should default to enabled', async () => {
    const toggle = await toggleStore({ defaultEnabled: true, directory: '/repo', storage: makeStorage() })

    expect(toggle.enabled()).toBe(true)
  })

  it('should flip the folder state', async () => {
    const toggle = await toggleStore({ defaultEnabled: true, directory: '/repo', storage: makeStorage() })

    await expect(toggle.toggle()).resolves.toBe(false)
    expect(toggle.enabled()).toBe(false)
    await expect(toggle.toggle()).resolves.toBe(true)
    expect(toggle.enabled()).toBe(true)
  })

  it('should persist the state and rehydrate it from storage', async () => {
    const storage = makeStorage()
    await toggleStore({ defaultEnabled: true, directory: '/repo', storage }).then(toggle => toggle.toggle())

    const rehydrated = await toggleStore({ defaultEnabled: true, directory: '/repo', storage })
    expect(rehydrated.enabled()).toBe(false)
  })

  it('should keep folders independent', async () => {
    const storage = makeStorage()
    const first = await toggleStore({ defaultEnabled: true, directory: '/first', storage })
    const second = await toggleStore({ defaultEnabled: true, directory: '/second', storage })

    await first.toggle()

    expect(first.enabled()).toBe(false)
    expect(second.enabled()).toBe(true)
  })

  it('should respect a disabled default', async () => {
    const toggle = await toggleStore({ defaultEnabled: false, directory: '/repo', storage: makeStorage() })

    expect(toggle.enabled()).toBe(false)
    await expect(toggle.toggle()).resolves.toBe(true)
  })

  it('should reject and keep the previous state when persisting fails', async () => {
    const data = new Map<string, unknown>()
    let failures = 1
    const storage = {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: boolean) => {
        if (failures > 0) {
          failures--
          throw new Error('storage unavailable')
        }
        data.set(key, value)
      },
    }
    const toggle = await toggleStore({ defaultEnabled: true, directory: '/repo', storage })

    await expect(toggle.toggle()).rejects.toThrow('storage unavailable')
    expect(toggle.enabled()).toBe(true)

    await expect(toggle.toggle()).resolves.toBe(false)
    expect(toggle.enabled()).toBe(false)
    expect(data.get('directory:/repo')).toBe(false)
  })

  it('should ignore unusable persisted state', async () => {
    const toggle = await toggleStore({
      defaultEnabled: true,
      directory: '/repo',
      storage: makeStorage({ 'directory:/repo': 'garbage' }),
    })

    expect(toggle.enabled()).toBe(true)
  })
})
