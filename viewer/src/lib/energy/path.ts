import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { EnergySourceError, type EnergyDirectory } from './types'
import { energyDirectoryFromEntries, type SourceEntry } from './discover'

const ENERGY_DIRECTORY = '.energy'

/**
 * Creates an EnergyDirectory from a local folder path. The folder must
 * contain a `.energy` folder or `ses_*.jsonl` files.
 */
export async function energyDirectoryFromPath(input: string): Promise<EnergyDirectory> {
  const folder = input.startsWith('~') ? path.join(homedir(), input.slice(1)) : input
  const stats = await stat(folder).catch(() => null)
  if (stats === null) {
    throw new EnergySourceError(`Folder not found: ${input}`)
  }
  if (!stats.isDirectory()) {
    throw new EnergySourceError(`Not a folder: ${input}`)
  }
  const entries = await readFolderEntries(folder)
  return energyDirectoryFromEntries(entries, `in ${input}`)
}

/**
 * Lists the files of a folder: the files sitting directly in it, plus the
 * files inside its `.energy` folder, mirroring the flat listing of an
 * archive.
 */
async function readFolderEntries(folder: string): Promise<SourceEntry[]> {
  const dirents = await readdir(folder, { withFileTypes: true })
  const files = dirents
    .filter(dirent => dirent.isFile())
    .map(dirent => ({
      path: dirent.name,
      read: () => readFile(path.join(folder, dirent.name), 'utf8'),
    }))
  return [...files, ...(await readEnergyFolderEntries(folder))]
}

async function readEnergyFolderEntries(folder: string): Promise<SourceEntry[]> {
  const energyFolder = path.join(folder, ENERGY_DIRECTORY)
  const stats = await stat(energyFolder).catch(() => null)
  if (stats === null || !stats.isDirectory()) {
    return []
  }

  // TODO: code redundancy with the above
  const dirents = await readdir(energyFolder, { withFileTypes: true })
  return dirents
    .filter(dirent => dirent.isFile())
    .map(dirent => ({
      path: `${ENERGY_DIRECTORY}/${dirent.name}`,
      read: () => readFile(path.join(energyFolder, dirent.name), 'utf8'),
    }))
}
