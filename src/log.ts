import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PREFIX = '[energy-logger]'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

export function logFilePath(): string {
  const stateDir = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return join(stateDir, 'opencode-energy-logger', 'energy-logger.log')
}

let ensured: { dir: string, promise: Promise<void> } | undefined
const pendingWrites = new Set<Promise<void>>()

// appends run one at a time: concurrent appendFile calls of records larger
// than the single-write size supported by the platform (node/bun) would interleave their
// chunks and corrupt both records
let writeQueue: Promise<void> = Promise.resolve()

function ensureLogDir(): Promise<void> {
  const dir = dirname(logFilePath())
  if (ensured?.dir !== dir) {
    ensured = {
      dir,
      promise: mkdir(dir, { recursive: true }).then(() => {}),
    }
  }

  const attempt = ensured
  return attempt.promise.catch((error) => {
    // drop the failed attempt so the next write retries the directory creation
    if (ensured === attempt) {
      ensured = undefined
    }
    throw error
  })
}

async function writeWithRetries(line: string, reportFailures: boolean): Promise<void> {
  for (let retries = 0; ; retries++) {
    try {
      await ensureLogDir()
      await appendFile(logFilePath(), line)
      return
    } catch (error) {
      // debug lines are written with reportFailures disabled so a failing log
      // target cannot spawn an endless chain of failure reports
      if (reportFailures) {
        debug(`log write failed: ${String(error)}`)
      }

      if (retries >= MAX_RETRIES) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}

function writeLine(line: string, reportFailures: boolean): void {
  const pending = writeQueue
    .then(() => writeWithRetries(line, reportFailures))
    .finally(() => pendingWrites.delete(pending))

  pendingWrites.add(pending)

  // a failed write must not stop the queue
  writeQueue = pending.catch(() => {})
}

/** Awaits every log write started so far, including writes waiting on a retry. */
export async function drain(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites])
  }
}

function format(args: unknown[]): string {
  const timestamp = new Date().toISOString()

  const message = args
    .map((arg) => {
      if (typeof arg === 'string') {
        return arg
      }
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')

  return `${timestamp} ${PREFIX} ${message}\n`
}

export function log(...args: unknown[]): void {
  void writeLine(format(args), true)
}

export function debug(...args: unknown[]): void {
  if (process.env.ENERGY_LOGGER_DEBUG) {
    void writeLine(format(args), false)
  }
}
