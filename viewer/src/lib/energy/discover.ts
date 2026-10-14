import { basename } from 'node:path'
import { EnergySourceError, type EnergyDirectory, type EnergyFile } from './types'

/**
 * A file entry found in a source, addressed by its path relative to the
 * root of the source, e.g. `.energy/ses_x.jsonl`.
 */
export interface SourceEntry {
  readonly path: string
  read(): Promise<string>
}

const ENERGY_DIRECTORY = '.energy'
const SESSION_FILE = /^ses_.+\.jsonl$/

/**
 * True for energy record filenames like `ses_1e2f3g4h5i6j7k8l.jsonl`.
 */
export function isSessionFileName(name: string): boolean {
  return SESSION_FILE.test(name)
}

/**
 * Finds the energy files in a list of source entries and wraps them in an
 * energy directory, or throws when there are none.
 *
 * The entries may sit at the root of the source, or inside a single
 * top-level directory — the way GitHub and Forgejo nest repository
 * tarballs, and the way archivers zip up a folder. At each level a
 * `.energy` folder takes precedence over session files sitting directly
 * in it.
 */
export function energyDirectoryFromEntries(entries: SourceEntry[], context: string): EnergyDirectory {
  const files = findEnergyFiles(entries)
  if (files.length === 0) {
    throw new EnergySourceError(`No energy files (ses_*.jsonl) found ${context}`)
  }
  return energyDirectoryOf(files)
}

/**
 * Wraps a list of energy files in an {@link EnergyDirectory}.
 */
export function energyDirectoryOf(files: EnergyFile[]): EnergyDirectory {
  return {
    async *[Symbol.asyncIterator]() {
      yield* files
    },
  }
}

/**
 * Narrows source entries to a sub folder, the way a repository link can
 * point into a repository. Repository tarballs nest everything under a
 * single top-level directory, which is stripped along the way.
 */
export function scopeToSubPath(entries: SourceEntry[], subPath: string): SourceEntry[] {
  const wrapper = commonLeadingSegment(entries)
  const prefix = `${wrapper === null ? subPath : `${wrapper}/${subPath}`}/`
  return entries
    .filter(entry => entry.path.startsWith(prefix))
    .map(entry => ({
      path: entry.path.slice(prefix.length),
      read: () => entry.read(),
    }))
}

function findEnergyFiles(entries: SourceEntry[]): EnergyFile[] {
  // bound the descent so a malicious archive cannot loop forever.
  for (let depth = 0; depth < 4; depth++) {
    // if there is at least one entry that matches /.energy/ses_*.jsonl file, we treat
    // the .energy/ directory as a an energy directory
    const inEnergyDirectory = entries.filter(entry => {
      const segments = entry.path.split('/')
      return segments.length === 2 && segments[0] === ENERGY_DIRECTORY && isSessionFileName(segments[1])
    })
    if (inEnergyDirectory.length > 0) {
      return inEnergyDirectory.map(toEnergyFile)
    }

    // TODO: this can be merged with the above filter most likely
    // if at least one entry matches /ses_*.jsonl, we treat the current root the energy directory
    const atRoot = entries.filter(entry => !entry.path.includes('/') && isSessionFileName(entry.path))
    if (atRoot.length > 0) {
      return atRoot.map(toEnergyFile)
    }

    // if all the entries have the same path segments in the beginning, it's just a single
    // directory containing a directory. strip this common prefix to get to the nested
    // files
    const wrapper = commonLeadingSegment(entries)
    if (wrapper === null) {
      return []
    }

    const prefix = `${wrapper}/`
    entries = entries
      .filter(entry => entry.path.startsWith(prefix))
      .map(entry => ({
        path: entry.path.slice(prefix.length),
        read: () => entry.read(),
      }))
  }
  return []
}

function commonLeadingSegment(entries: SourceEntry[]): string | null {
  let segment: string | null = null
  for (const entry of entries) {
    const slash = entry.path.indexOf('/')
    if (slash <= 0) {
      return null
    }
    const head = entry.path.slice(0, slash)
    if (segment === null) {
      segment = head
    } else if (segment !== head) {
      return null
    }
  }
  return segment
}

function toEnergyFile(entry: SourceEntry): EnergyFile {
  return {
    filename: basename(entry.path),
    read: () => entry.read(),
  }
}
