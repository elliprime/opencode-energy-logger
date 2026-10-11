import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureIgnored, findRepoRoot, readGitBranch } from '../src/git.js'
import plugin from '../src/index.js'
import type { Plugin } from '@opencode/plugin'
import { logFilePath } from '../src/log.js'

vi.mock('../src/git.js', () => ({
  readGitBranch: vi.fn(async () => undefined),
  findRepoRoot: vi.fn(async () => undefined),
  ensureIgnored: vi.fn(async () => undefined),
}))

const stateDir = mkdtempSync(join(tmpdir(), 'energy-logger-plugin-test-'))
process.env.XDG_STATE_HOME = stateDir

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

const mockedReadGitBranch = vi.mocked(readGitBranch)
const mockedFindRepoRoot = vi.mocked(findRepoRoot)
const mockedEnsureIgnored = vi.mocked(ensureIgnored)

beforeEach(() => {
  mockedReadGitBranch.mockClear()
  mockedFindRepoRoot.mockClear()
  mockedEnsureIgnored.mockClear()
})

type HookEvent = {
  sessionID: string
  agent: string
  kind: 'primary' | 'compaction' | 'title' | 'generate'
  model: { providerID: string, id: string, variant?: string }
  request: Request
  response?: Response
}

type HookCallback = (event: HookEvent) => Promise<void> | void

type HookEntry = {
  name: string
  callback: HookCallback
  disposed: boolean
  dispose: () => Promise<void>
}

type RpcErrorFactory = (type: string, message: string, data?: unknown) => unknown

type RpcContext = {
  error: RpcErrorFactory
}

type RpcHandlerMap = Record<string, (input: unknown, context?: RpcContext) => Promise<unknown>>

type CommandDefinition = {
  name: string
  description?: string
  execute: (input: { sessionID: string, prompt: unknown, delivery: unknown }) => Promise<void>
}

function makeContext(options: { directory?: string, hookDelayMs?: number } = {}) {
  const directory = options.directory ?? mkdtempSync(join(stateDir, 'project-'))
  const sessionHooks: HookEntry[] = []
  const rpcHandlers: RpcHandlerMap = {}
  const commands: CommandDefinition[] = []
  const emitted = vi.fn()

  const context = {
    location: { directory },
    options: {},
    session: {
      hook: async (name: string, callback: HookCallback) => {
        if ((options.hookDelayMs ?? 0) > 0) {
          await new Promise(resolve => setTimeout(resolve, options.hookDelayMs))
        }
        const entry: HookEntry = {
          name,
          callback,
          disposed: false,
          dispose: async () => {
            entry.disposed = true
          },
        }
        sessionHooks.push(entry)
        return { dispose: entry.dispose }
      },
    },
    rpc: {
      register: async (_definition: unknown, handlers: RpcHandlerMap) => {
        Object.assign(rpcHandlers, handlers)
        return {
          events: {
            emit: emitted,
          },
        }
      },
    },
    command: {
      transform: async (callback: (editor: { add: (definition: CommandDefinition) => void }) => void) => {
        callback({
          add: (definition) => {
            commands.push(definition)
          },
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context

  return { context, sessionHooks, rpcHandlers, commands, emitted, directory }
}

function writeConfig(directory: string, name: string, value: unknown): void {
  mkdirSync(join(directory, '.opencode'), { recursive: true })
  writeFileSync(join(directory, '.opencode', name), `${JSON.stringify(value, null, 2)}\n`)
}

function readLocalOverride(directory: string): unknown {
  return JSON.parse(readFileSync(join(directory, '.opencode', 'energy.local.json'), 'utf8'))
}

function readLog(): string {
  try {
    return readFileSync(logFilePath(), 'utf8')
  } catch {
    return ''
  }
}

function energyEntries(): Record<string, unknown>[] {
  return readLog()
    .split('\n')
    .filter(line => line.includes('"type":"energy"'))
    .map(line => JSON.parse(line.slice(line.indexOf('[energy-logger] ') + '[energy-logger] '.length)))
}

async function waitForEnergyEntries(expectedCount: number): Promise<Record<string, unknown>[]> {
  const start = Date.now()
  while (Date.now() - start < 2000) {
    const entries = energyEntries()
    if (entries.length >= expectedCount) {
      return entries
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${expectedCount} energy entries, log contains:\n${readLog()}`)
}

const baseEvent: Omit<HookEvent, 'request'> = {
  sessionID: 'ses_1',
  agent: 'build',
  kind: 'primary',
  model: { providerID: 'neuralwatt', id: 'test-model' },
}

function modelRequest(): Request {
  return new Request('http://127.0.0.1:1/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'wired up' }] }),
  })
}

function energyResponse(): Response {
  return new Response(': energy {"total_joules": 2.5}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('plugin', () => {
  it('should capture energy with the git branch read when the record is written', async () => {
    mockedReadGitBranch.mockResolvedValue('feature/energy')

    const { context, sessionHooks, directory } = makeContext()
    await plugin.setup(context)

    expect(plugin.id).toBe('opencode-energy-logger')
    expect(sessionHooks.map(hook => hook.name)).toEqual(['http.request', 'http.response'])

    const entriesBefore = energyEntries().length
    const request = modelRequest()

    await sessionHooks[0].callback({ ...baseEvent, request })
    expect(mockedReadGitBranch).not.toHaveBeenCalled()

    await sessionHooks[1].callback({ ...baseEvent, request, response: energyResponse() })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(mockedReadGitBranch).toHaveBeenCalledWith(directory)
    expect(entry.sessionID).toBe('ses_1')
    expect(entry.branch).toBe('feature/energy')
    expect(entry.energy).toEqual([{ total_joules: 2.5 }])
  })

  it('should omit the branch when no request hook fired for the request', async () => {
    const { context, sessionHooks } = makeContext()
    await plugin.setup(context)

    const entriesBefore = energyEntries().length

    await sessionHooks[1].callback({
      ...baseEvent,
      sessionID: 'ses_2',
      request: modelRequest(),
      response: energyResponse(),
    })

    expect(mockedReadGitBranch).not.toHaveBeenCalled()

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.branch).toBeUndefined()
    expect(entry.energy).toEqual([{ total_joules: 2.5 }])
  })

  it('should return an awaitable cleanup from setup', async () => {
    const { context, sessionHooks } = makeContext()
    const cleanup = await plugin.setup(context)

    expect(sessionHooks.map(hook => hook.name)).toEqual(['http.request', 'http.response'])
    expect(cleanup).toBeTypeOf('function')
    if (typeof cleanup === 'function') {
      await cleanup()
    }
  })

  it('should not log energy while the folder toggle is off', async () => {
    const { context, sessionHooks, rpcHandlers } = makeContext()
    await plugin.setup(context)
    await rpcHandlers.toggle({})

    const entriesBefore = energyEntries().length

    // the folder state gates every session, not just the one that toggled
    for (const sessionID of ['ses_1', 'ses_2']) {
      const gatedRequest = modelRequest()
      await sessionHooks[0].callback({ ...baseEvent, sessionID, request: gatedRequest })
      await sessionHooks[1].callback({ ...baseEvent, sessionID, request: gatedRequest, response: energyResponse() })
    }

    await new Promise(resolve => setTimeout(resolve, 300))
    expect(energyEntries().length).toBe(entriesBefore)
    expect(mockedReadGitBranch).not.toHaveBeenCalled()

    await rpcHandlers.toggle({})

    const request = modelRequest()
    await sessionHooks[0].callback({ ...baseEvent, request })
    await sessionHooks[1].callback({ ...baseEvent, request, response: energyResponse() })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.sessionID).toBe('ses_1')
    expect(entry.energy).toEqual([{ total_joules: 2.5 }])
  })

  it('should unregister the http hooks while the folder toggle is off', async () => {
    const { context, sessionHooks, rpcHandlers } = makeContext()
    await plugin.setup(context)

    expect(sessionHooks.map(hook => hook.name)).toEqual(['http.request', 'http.response'])
    expect(sessionHooks.every(hook => !hook.disposed)).toBe(true)

    await rpcHandlers.toggle({})

    expect(sessionHooks.every(hook => hook.disposed)).toBe(true)
  })

  it('should register the http hooks again when the folder toggle is turned back on', async () => {
    const { context, sessionHooks, rpcHandlers } = makeContext()
    await plugin.setup(context)
    await rpcHandlers.toggle({})
    await rpcHandlers.toggle({})

    const active = sessionHooks.filter(hook => !hook.disposed)
    expect(active.map(hook => hook.name)).toEqual(['http.request', 'http.response'])
  })

  it('should not register the http hooks when the folder state starts disabled', async () => {
    const { context, sessionHooks, directory } = makeContext()
    writeConfig(directory, 'energy.local.json', { enabled: false })
    await plugin.setup(context)

    expect(sessionHooks).toEqual([])
  })

  it('should apply concurrent toggles one at a time', async () => {
    const { context, rpcHandlers, emitted, directory } = makeContext()
    await plugin.setup(context)

    const results = await Promise.all([rpcHandlers.toggle({}), rpcHandlers.toggle({})])

    expect(results).toEqual([{ enabled: false }, { enabled: true }])
    expect(emitted.mock.calls).toEqual([
      ['toggled', { directory, enabled: false }],
      ['toggled', { directory, enabled: true }],
    ])
  })

  it('should dispose the http hooks even when a disable toggle arrives while the hooks are registering', async () => {
    const { context, sessionHooks, rpcHandlers, directory } = makeContext({ hookDelayMs: 50 })
    writeConfig(directory, 'energy.local.json', { enabled: false })
    await plugin.setup(context)

    const enabling = rpcHandlers.toggle({})
    await new Promise(resolve => setTimeout(resolve, 10))
    const disabling = rpcHandlers.toggle({})
    await Promise.all([enabling, disabling])

    expect(await rpcHandlers.get({})).toEqual({ enabled: false })
    expect(sessionHooks.map(hook => hook.name)).toEqual(['http.request', 'http.response'])
    expect(sessionHooks.every(hook => hook.disposed)).toBe(true)
  })

  it('should expose the folder state over rpc', async () => {
    const { context, rpcHandlers } = makeContext()
    await plugin.setup(context)

    await expect(rpcHandlers.get({})).resolves.toEqual({ enabled: true })

    await rpcHandlers.toggle({})

    await expect(rpcHandlers.get({})).resolves.toEqual({ enabled: false })
  })

  it('should emit a toggled event when the state flips', async () => {
    const { context, rpcHandlers, emitted, directory } = makeContext()
    await plugin.setup(context)

    await rpcHandlers.toggle({})

    expect(emitted).toHaveBeenCalledWith('toggled', { directory, enabled: false })
  })

  it('should surface a persist failure without flipping the folder state', async () => {
    const { context, sessionHooks, rpcHandlers, emitted, directory } = makeContext()
    await plugin.setup(context)

    // a directory at the override path makes the atomic rename fail
    const blocking = join(directory, '.opencode', 'energy.local.json')
    mkdirSync(blocking, { recursive: true })

    const error: RpcErrorFactory = (type, message, data) => ({ type, message, data })
    await expect(rpcHandlers.toggle({}, { error })).resolves.toEqual({
      type: 'toggle_failed',
      message: expect.stringContaining('could not toggle energy logging:'),
      data: { message: expect.stringContaining('rename') },
    })

    expect(await rpcHandlers.get({})).toEqual({ enabled: true })
    expect(emitted).not.toHaveBeenCalled()
    expect(sessionHooks.every(hook => !hook.disposed)).toBe(true)

    // the failed flip leaves the queue usable and the next persist succeeds
    rmSync(blocking, { recursive: true, force: true })
    await expect(rpcHandlers.toggle({}, { error })).resolves.toEqual({ enabled: false })
    expect(emitted).toHaveBeenCalledWith('toggled', { directory, enabled: false })
    expect(sessionHooks.every(hook => hook.disposed)).toBe(true)
  })

  it('should toggle the state through the /energy command', async () => {
    const { context, rpcHandlers, commands } = makeContext()
    await plugin.setup(context)

    const energyCommand = commands.find(command => command.name === 'energy')
    expect(energyCommand?.description).toBe('Toggle energy logging for this folder')

    await energyCommand!.execute({ sessionID: 'ses_1', prompt: {}, delivery: 'steer' })

    await expect(rpcHandlers.get({})).resolves.toEqual({ enabled: false })
  })

  it('should restore the toggle state when the plugin is reloaded', async () => {
    const first = makeContext()
    await plugin.setup(first.context)
    await first.rpcHandlers.toggle({})

    const second = makeContext({ directory: first.directory })
    await plugin.setup(second.context)

    await expect(second.rpcHandlers.get({})).resolves.toEqual({ enabled: false })
  })

  it('should read the committed config at the repository root when the directory is inside a repository', async () => {
    const { directory: repo } = makeContext()
    writeConfig(repo, 'energy.json', { enabled: false })
    const nested = join(repo, 'nested')
    mkdirSync(nested, { recursive: true })

    mockedFindRepoRoot.mockResolvedValueOnce(repo)
    const { context, sessionHooks } = makeContext({ directory: nested })
    await plugin.setup(context)

    expect(sessionHooks).toEqual([])
  })

  it('should ignore the local override in the repository when it is toggled', async () => {
    const { context, rpcHandlers, directory } = makeContext()
    mockedFindRepoRoot.mockResolvedValueOnce(directory)
    await plugin.setup(context)

    await rpcHandlers.toggle({})

    expect(mockedEnsureIgnored).toHaveBeenCalledWith(directory, '.opencode/energy.local.json')
    expect(readLocalOverride(directory)).toEqual({ enabled: false })
  })

  it('should not touch the repository exclude file outside a repository', async () => {
    const { context, rpcHandlers } = makeContext()
    await plugin.setup(context)

    await rpcHandlers.toggle({})

    expect(mockedEnsureIgnored).not.toHaveBeenCalled()
  })
})
