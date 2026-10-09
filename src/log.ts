const PREFIX = '[energy-logger]'

export function log(...args: unknown[]): void {
  console.log(PREFIX, ...args)
}

export function debug(...args: unknown[]): void {
  if (process.env.ENERGY_LOGGER_DEBUG) {
    log(...args)
  }
}
