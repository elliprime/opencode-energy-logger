import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { debug } from './log.js'

export interface ToggleStore {
  enabled(): boolean
  toggle(): Promise<boolean>
}

const configDirName = '.opencode'
const committedName = 'energy.json'
const localName = 'energy.local.json'

export const localOverridePath = `${configDirName}/${localName}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function readEnabled(file: string): Promise<boolean | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    // a missing file is the normal case
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debug(`energy config read failed at ${file}: ${String(error)}`)
    }
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed) && typeof parsed.enabled === 'boolean') {
      return parsed.enabled
    }
    debug(`energy config at ${file} holds no boolean enabled`)
  } catch (error) {
    debug(`energy config parse failed at ${file}: ${String(error)}`)
  }

  return undefined
}

/** Writes the local override atomically so readers never see a partial file. */
async function writeEnabled(directory: string, enabled: boolean): Promise<void> {
  const file = join(directory, localOverridePath)
  const temp = `${file}.${process.pid}.tmp`

  await mkdir(join(directory, configDirName), { recursive: true })
  await writeFile(temp, `${JSON.stringify({ enabled }, null, 2)}\n`)

  try {
    await rename(temp, file)
  } catch (error) {
    // the temporary file must not linger: it would surface as an untracked
    // file git has not been told to ignore
    await unlink(temp).catch(() => {})
    throw error
  }
}

/**
 * Folder level toggle for energy logging.
 *
 * The committed `.opencode/energy.json` is the shared default; the gitignored
 * `.opencode/energy.local.json` overrides it per machine and is the only file
 * the toggle writes.
 */
export async function toggleStore(
  input: {
    defaultEnabled: boolean
    directory: string
  },
): Promise<ToggleStore> {
  const { defaultEnabled, directory } = input

  const local = await readEnabled(join(directory, localOverridePath))
  const committed = local === undefined ? await readEnabled(join(directory, configDirName, committedName)) : undefined
  let current = local ?? committed ?? defaultEnabled

  return {
    enabled: () => current,
    toggle: async () => {
      const previous = current
      current = !current

      try {
        await writeEnabled(directory, current)
      } catch (error) {
        // saving failed, so revert the change to the in memory value
        current = previous
        debug(`toggle state persist failed: ${String(error)}`)
        throw error
      }

      return current
    },
  }
}
