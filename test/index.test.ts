import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../src/index.js'
import type { PluginInput } from '@opencode-ai/plugin'
import type { Event } from '@opencode-ai/sdk'

const stateDir = mkdtempSync(join(tmpdir(), 'energy-logger-plugin-test-'))
process.env.XDG_STATE_HOME = stateDir

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

const input = {
  client: {},
  project: { id: 'test-project', worktree: '/tmp', vcs: 'git' },
  directory: '/tmp',
  worktree: '/tmp',
  experimental_workspace: { register: () => {} },
  serverUrl: new URL('http://localhost:4096'),
  $: async () => '',
} as unknown as PluginInput

describe('plugin', () => {
  it('loads without throwing and returns usable hooks', async () => {
    const hooks = await plugin(input)
    expect(hooks).toBeTypeOf('object')

    await hooks.event?.({ event: { type: 'message.updated' } as Event })
    await hooks['tool.execute.after']?.(
      { tool: 'bash', sessionID: 'ses', callID: 'call', args: {} },
      { title: 'bash', output: '', metadata: {} },
    )
    await hooks.dispose?.()
  })
})
