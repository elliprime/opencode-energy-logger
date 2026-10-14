import AdmZip from 'adm-zip'
import { Readable } from 'node:stream'
import { EnergySourceError, type EnergyDirectory } from './types'
import { energyDirectoryFromEntries, type SourceEntry } from './discover'
import { readTarEntries } from './tar-entries'

/**
 * creates an energy directory from an uploaded archive. The archive must
 * be a .zip or .tar.gz file containing a `.energy` folder or
 * `ses_*.jsonl` files.
 */
export async function energyDirectoryFromArchive(data: Buffer): Promise<EnergyDirectory> {
  const kind = sniffArchive(data)
  if (kind === 'bzip2') {
    throw new EnergySourceError('bzip2 archives are not supported yet; upload the folder as a .zip or .tar.gz archive instead')
  }

  if (kind !== 'zip' && kind !== 'gzip') {
    throw new EnergySourceError('Not a supported archive: expected a .zip or .tar.gz archive containing a .energy folder or ses_*.jsonl files')
  }

  const entries = kind === 'zip' ? zipEntries(data) : await readTarEntries(Readable.from([data]), 'the archive')
  return energyDirectoryFromEntries(entries, 'in the archive')
}

type ArchiveKind = 'zip' | 'gzip' | 'bzip2' | null

/**
 * Recognizes archives by their magic bytes rather than their file name.
 */
function sniffArchive(data: Buffer): ArchiveKind {
  if (data.length >= 2 && data[0] === 0x50 && data[1] === 0x4b) {
    return 'zip'
  }

  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return 'gzip'
  }

  if (data.length >= 3 && data[0] === 0x42 && data[1] === 0x5a && data[2] === 0x68) {
    return 'bzip2'
  }

  return null
}

function zipEntries(data: Buffer): SourceEntry[] {
  const zip = new AdmZip(data)
  return zip
    .getEntries()
    .filter(entry => !entry.isDirectory && !entry.entryName.startsWith('__MACOSX/'))
    .map(entry => ({
      path: entry.entryName.replaceAll('\\', '/'),
      read: async () => entry.getData().toString('utf8'),
    }))
}
