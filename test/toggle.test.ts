import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { toggleStore } from '../src/toggle.store.js'

const root = mkdtempSync(join(tmpdir(), 'energy-logger-toggle-test-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeDirectory(name: string): string {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  return directory
}

function writeConfig(directory: string, name: string, value: unknown): void {
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
}

function readLocalOverride(directory: string): unknown {
  return JSON.parse(readFileSync(join(directory, '.energy.local.json'), 'utf8'))
}

describe('toggleStore', () => {
  it('should default to enabled', async () => {
    const toggle = await toggleStore({ defaultEnabled: true, directory: makeDirectory('default') })

    expect(toggle.enabled()).toBe(true)
  })

  it('should respect a disabled default', async () => {
    const toggle = await toggleStore({ defaultEnabled: false, directory: makeDirectory('disabled-default') })

    expect(toggle.enabled()).toBe(false)
    await expect(toggle.toggle()).resolves.toBe(true)
  })

  it('should read the committed config', async () => {
    const directory = makeDirectory('committed')
    writeConfig(directory, '.energy.json', { enabled: false })

    const toggle = await toggleStore({ defaultEnabled: true, directory })

    expect(toggle.enabled()).toBe(false)
  })

  it('should prefer the local override over the committed config', async () => {
    const directory = makeDirectory('override')
    writeConfig(directory, '.energy.json', { enabled: true })
    writeConfig(directory, '.energy.local.json', { enabled: false })

    const toggle = await toggleStore({ defaultEnabled: true, directory })

    expect(toggle.enabled()).toBe(false)
  })

  it('should ignore unusable config files', async () => {
    const directory = makeDirectory('garbage')
    writeConfig(directory, '.energy.json', { enabled: 'yes' })
    writeFileSync(join(directory, '.energy.local.json'), 'not json')

    const toggle = await toggleStore({ defaultEnabled: true, directory })

    expect(toggle.enabled()).toBe(true)
  })

  it('should flip the folder state', async () => {
    const directory = makeDirectory('flip')
    const toggle = await toggleStore({ defaultEnabled: true, directory })

    await expect(toggle.toggle()).resolves.toBe(false)
    expect(toggle.enabled()).toBe(false)
    expect(readLocalOverride(directory)).toEqual({ enabled: false })

    await expect(toggle.toggle()).resolves.toBe(true)
    expect(toggle.enabled()).toBe(true)
    expect(readLocalOverride(directory)).toEqual({ enabled: true })
  })

  it('should persist the state and rehydrate it', async () => {
    const directory = makeDirectory('rehydrate')
    await toggleStore({ defaultEnabled: true, directory }).then(toggle => toggle.toggle())

    const rehydrated = await toggleStore({ defaultEnabled: true, directory })
    expect(rehydrated.enabled()).toBe(false)
  })

  it('should keep the local override outside the .opencode config directory', async () => {
    const directory = makeDirectory('outside-config')
    const toggle = await toggleStore({ defaultEnabled: true, directory })

    await toggle.toggle()

    // a write inside .opencode makes opencode reload its config and with it
    // this plugin, racing the toggle's own reply to the footer icon
    expect(existsSync(join(directory, '.opencode'))).toBe(false)
    expect(readLocalOverride(directory)).toEqual({ enabled: false })
  })

  it('should keep folders independent', async () => {
    const first = await toggleStore({ defaultEnabled: true, directory: makeDirectory('first') })
    const second = await toggleStore({ defaultEnabled: true, directory: makeDirectory('second') })

    await first.toggle()

    expect(first.enabled()).toBe(false)
    expect(second.enabled()).toBe(true)
  })

  it('should reject and keep the previous state when persisting fails', async () => {
    const directory = makeDirectory('persist-failure')
    // a directory at the override path makes the atomic rename fail
    const blocking = join(directory, '.energy.local.json')
    mkdirSync(blocking, { recursive: true })

    const toggle = await toggleStore({ defaultEnabled: true, directory })

    await expect(toggle.toggle()).rejects.toThrow()
    expect(toggle.enabled()).toBe(true)
    // the failed write leaves no temporary file behind
    expect(readdirSync(directory)).toEqual(['.energy.local.json'])

    rmSync(blocking, { recursive: true, force: true })

    await expect(toggle.toggle()).resolves.toBe(false)
    expect(toggle.enabled()).toBe(false)
    expect(readLocalOverride(directory)).toEqual({ enabled: false })
  })
})
