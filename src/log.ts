import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PREFIX = '[energy-logger]'

export function logFilePath(): string {
  const stateDir = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return join(stateDir, 'opencode-energy-logger', 'energy-logger.log')
}

let ensureDir: Promise<void> | undefined

function writeLine(line: string): void {
  const file = logFilePath()

  ensureDir ??= mkdir(dirname(file), { recursive: true }).then(() => {})

  void ensureDir
    .then(() => appendFile(file, line))
    .catch(() => {})
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
  writeLine(format(args))
}

export function debug(...args: unknown[]): void {
  if (process.env.ENERGY_LOGGER_DEBUG) {
    log(...args)
  }
}
