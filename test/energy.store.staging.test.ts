import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEnergyRecord, flushEnergyRecords } from '../src/energy.store.js'
import { flush } from '../src/log.js'

const stageRuns = vi.hoisted(() => [] as string[])
const stageFailures = vi.hoisted(() => ({ remaining: 0 }))

vi.mock('../src/git.js', () => ({
  isIgnored: async () => false,
  showHeadFile: async () => undefined,
  stagePath: async (_repoRoot: string, relativePath: string) => {
    stageRuns.push(relativePath)
    if (stageFailures.remaining > 0) {
      stageFailures.remaining--
      return false
    }
    return true
  },
}))

const root = mkdtempSync(join(tmpdir(), 'energy-logger-staging-test-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  // the fake clock makes the settle window boundaries exact
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  stageRuns.length = 0
  stageFailures.remaining = 0
  process.env.XDG_STATE_HOME = join(root, 'state')
  mkdirSync(join(root, 'state'), { recursive: true })
})

afterEach(async () => {
  await flushEnergyRecords()
  await flush()
  vi.useRealTimers()
})

function record(n: number, sessionID = 'ses_1'): Record<string, unknown> {
  return { type: 'energy', time: `1970-01-01T00:00:0${n}.000Z`, sessionID, energy: [{ total_joules: n }] }
}

describe('energy view staging', () => {
  it('should stage the energy directory once for a burst of records', async () => {
    const repo = join(root, 'repo-burst')
    mkdirSync(repo)

    appendEnergyRecord(record(1), repo)
    appendEnergyRecord(record(2), repo)
    appendEnergyRecord(record(3), repo)
    await flushEnergyRecords()

    // one run for the first record and one completing the deferred rest
    expect(stageRuns).toEqual(['.energy', '.energy'])
  })

  it('should stage again for records after the settle window', async () => {
    const repo = join(root, 'repo-window')
    mkdirSync(repo)

    appendEnergyRecord(record(1), repo)
    await flushEnergyRecords()
    expect(stageRuns).toEqual(['.energy'])

    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
    appendEnergyRecord(record(2), repo)
    await flushEnergyRecords()

    expect(stageRuns).toEqual(['.energy', '.energy'])
  })

  it('should retry a failed staging run at the flush', async () => {
    const repo = join(root, 'repo-retry')
    mkdirSync(repo)
    stageFailures.remaining = 1

    appendEnergyRecord(record(1), repo)
    await flushEnergyRecords()

    // the record's run failed and the flush completed it
    expect(stageRuns).toEqual(['.energy', '.energy'])
  })

  it('should complete the flush when the staging run keeps failing', async () => {
    const repo = join(root, 'repo-broken-git')
    mkdirSync(repo)
    stageFailures.remaining = 100

    appendEnergyRecord(record(1), repo)
    await flushEnergyRecords()

    // one attempt per repository per flush: the flush returns with the
    // repository still marked
    expect(stageRuns).toEqual(['.energy', '.energy'])

    // the repository's mark survives its failed attempts, so let the
    // afterEach flush resolve it for the next test
    stageFailures.remaining = 0
  })

  it('should retry a repository that failed staging at a later flush', async () => {
    const repo = join(root, 'repo-later-flush')
    mkdirSync(repo)
    stageFailures.remaining = 2

    appendEnergyRecord(record(1), repo)
    await flushEnergyRecords()

    // the record's run and the flush's own attempt both failed
    expect(stageRuns).toEqual(['.energy', '.energy'])

    await flushEnergyRecords()

    // the repository stayed marked, so this flush attempted it again
    expect(stageRuns).toEqual(['.energy', '.energy', '.energy'])
  })
})
