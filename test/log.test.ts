import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drain, log } from '../src/log.js'

const baseDir = mkdtempSync(join(tmpdir(), 'energy-logger-log-test-'))
const lockedDirs: string[] = []

afterAll(() => {
  for (const dir of lockedDirs) {
    chmodSync(dir, 0o700)
  }
  rmSync(baseDir, { recursive: true, force: true })
})

afterEach(() => {
  delete process.env.ENERGY_LOGGER_DEBUG
})

function lockedState(name: string): string {
  const stateRoot = join(baseDir, name)
  mkdirSync(stateRoot)
  chmodSync(stateRoot, 0o500)
  lockedDirs.push(stateRoot)
  process.env.XDG_STATE_HOME = stateRoot
  return stateRoot
}

function unlock(stateRoot: string): void {
  chmodSync(stateRoot, 0o700)
}

async function waitForLog(stateRoot: string, predicate: (text: string) => boolean): Promise<string> {
  const file = join(stateRoot, 'opencode-energy-logger', 'energy-logger.log')
  const start = Date.now()

  while (Date.now() - start < 5000) {
    try {
      const text = readFileSync(file, 'utf8')
      if (predicate(text)) {
        return text
      }
    } catch {
      // the file may not exist yet
    }

    await new Promise(resolve => setTimeout(resolve, 50))
  }

  throw new Error(`timed out waiting for log content in ${file}`)
}

// chmod-based directory failures do not apply to root or non-POSIX filesystems
const skip = process.getuid?.() === 0 || process.platform === 'win32'

describe('log', () => {
  it.skipIf(skip)('should retry after a transient log directory failure and report it via debug', async () => {
    process.env.ENERGY_LOGGER_DEBUG = '1'
    const stateRoot = lockedState('state-recovery')

    const start = Date.now()
    log('first line')
    await new Promise(resolve => setTimeout(resolve, 100))
    unlock(stateRoot)

    const text = await waitForLog(stateRoot, contents =>
      contents.includes('first line') && contents.includes('log write failed'))
    expect(text).toContain('first line')
    expect(text).toContain('log write failed')
    // the write must wait before retrying instead of hammering the filesystem
    expect(Date.now() - start).toBeGreaterThanOrEqual(1500)
  })

  it.skipIf(skip)('should not report log write failures when debug output is disabled', async () => {
    const stateRoot = lockedState('state-quiet')

    log('quiet line')
    await new Promise(resolve => setTimeout(resolve, 100))
    unlock(stateRoot)

    const text = await waitForLog(stateRoot, contents => contents.includes('quiet line'))
    expect(text).not.toContain('log write failed')
  })

  it.skipIf(skip)('should flush pending writes before drain resolves', async () => {
    const stateRoot = lockedState('state-drain')

    log('flush me')
    await new Promise(resolve => setTimeout(resolve, 100))
    unlock(stateRoot)
    await drain()

    expect(readFileSync(join(stateRoot, 'opencode-energy-logger', 'energy-logger.log'), 'utf8')).toContain('flush me')
  })

  it('should write concurrent large records without interleaving them', async () => {
    const stateRoot = join(baseDir, 'state-concurrent')
    mkdirSync(stateRoot)
    process.env.XDG_STATE_HOME = stateRoot

    // above the single-write size, concurrent appends interleave their chunks
    const first = 'P'.repeat(600 * 1024)
    const second = 'Q'.repeat(600 * 1024)
    log(JSON.stringify({ type: 'energy', i: 1, prompt: first }))
    log(JSON.stringify({ type: 'energy', i: 2, prompt: second }))
    await drain()

    const lines = readFileSync(join(stateRoot, 'opencode-energy-logger', 'energy-logger.log'), 'utf8')
      .split('\n')
      .filter(line => line.length > 0)
    const records: Record<string, unknown>[] = lines.map(line =>
      JSON.parse(line.slice(line.indexOf('[energy-logger] ') + '[energy-logger] '.length)))
    expect(records.map(record => record.prompt)).toEqual([first, second])
  })
})
