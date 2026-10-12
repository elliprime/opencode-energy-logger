import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { debug, flush, logFilePath } from '../src/log.js'

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
  const file = logFilePath()
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

describe('debug', () => {
  it('should append debug lines to the log file while debug output is enabled', async () => {
    process.env.ENERGY_LOGGER_DEBUG = '1'
    const stateRoot = join(baseDir, 'state-append')
    mkdirSync(stateRoot)
    process.env.XDG_STATE_HOME = stateRoot

    debug('capturing', { type: 'energy' })

    await flush()
    expect(readFileSync(logFilePath(), 'utf8')).toContain('[energy-logger] capturing {"type":"energy"}')
  })

  it('should not write anything while debug output is disabled', async () => {
    const stateRoot = join(baseDir, 'state-disabled')
    mkdirSync(stateRoot)
    process.env.XDG_STATE_HOME = stateRoot

    debug('hidden line')

    await flush()
    expect(existsSync(logFilePath())).toBe(false)
  })

  it.skipIf(skip)('should retry after a transient log directory failure', async () => {
    process.env.ENERGY_LOGGER_DEBUG = '1'
    const stateRoot = lockedState('state-recovery')

    const start = Date.now()
    debug('first line')
    await new Promise(resolve => setTimeout(resolve, 100))
    unlock(stateRoot)

    const text = await waitForLog(stateRoot, contents => contents.includes('first line'))
    expect(text).toContain('first line')
    // the write must wait before retrying instead of hammering the filesystem
    expect(Date.now() - start).toBeGreaterThanOrEqual(1500)
  })

  it.skipIf(skip)('should flush pending writes before drain resolves', async () => {
    process.env.ENERGY_LOGGER_DEBUG = '1'
    const stateRoot = lockedState('state-drain')

    debug('flush me')
    await new Promise(resolve => setTimeout(resolve, 100))
    unlock(stateRoot)
    await flush()

    expect(readFileSync(logFilePath(), 'utf8')).toContain('flush me')
  })

  it('should write concurrent large debug lines without interleaving them', async () => {
    process.env.ENERGY_LOGGER_DEBUG = '1'
    const stateRoot = join(baseDir, 'state-concurrent')
    mkdirSync(stateRoot)
    process.env.XDG_STATE_HOME = stateRoot

    // above the single-write size, concurrent appends interleave their chunks
    const first = 'P'.repeat(600 * 1024)
    const second = 'Q'.repeat(600 * 1024)
    debug(JSON.stringify({ type: 'energy', i: 1, prompt: first }))
    debug(JSON.stringify({ type: 'energy', i: 2, prompt: second }))
    await flush()

    const lines = readFileSync(logFilePath(), 'utf8')
      .split('\n')
      .filter(line => line.length > 0)
    const records: Record<string, unknown>[] = lines.map(line =>
      JSON.parse(line.slice(line.indexOf('[energy-logger] ') + '[energy-logger] '.length)))
    expect(records.map(record => record.prompt)).toEqual([first, second])
  })
})
