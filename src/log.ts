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

// appends run one at a time: concurrent appendFile calls of lines larger
// than the single-write size supported by the platform (node/bun) would interleave their
// chunks and corrupt both lines
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

async function writeWithRetries(line: string): Promise<void> {
  for (let retries = 0; ; retries++) {
    try {
      await ensureLogDir()
      await appendFile(logFilePath(), line)
      return
    } catch {
      // failures stay unreported: the report would go to the same failing
      // target, and a broken log target must not affect anything else
      if (retries >= MAX_RETRIES) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}

function writeLine(line: string): void {
  const pending = writeQueue
    .then(() => writeWithRetries(line))
    .finally(() => pendingWrites.delete(pending))

  pendingWrites.add(pending)

  // a failed write must not stop the queue
  writeQueue = pending.catch(() => {})
}

/** Awaits every debug write started so far, including writes waiting on a retry. */
export async function flush(): Promise<void> {
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

/**
 * Writes a diagnostic line to the log file. Nothing is written while the
 * `ENERGY_LOGGER_DEBUG` environment variable is unset, so the file only
 * exists while debugging.
 */
export function debug(...args: unknown[]): void {
  if (process.env.ENERGY_LOGGER_DEBUG) {
    void writeLine(format(args))
  }
}
