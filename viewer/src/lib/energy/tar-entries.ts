import { Readable } from 'node:stream'
import { Parser, type ReadEntry } from 'tar'
import { isSessionFileName, type SourceEntry } from './discover'
import { EnergySourceError } from './types'

/**
 * Reads the entries of a (possibly gzipped) tar stream; the parser detects
 * gzip compression itself.
 *
 * A tar stream can only be read once, so while it passes by the paths of
 * all file entries are collected, along with the contents of the entries
 * that look like energy files (`ses_*.jsonl`). Every other entry is
 * discarded.
 */
export async function readTarEntries(source: Readable, description: string): Promise<SourceEntry[]> {
  const parser = new Parser()
  const entries: SourceEntry[] = []
  const contents = new Map<string, string>()

  parser.on('entry', (entry: ReadEntry) => {
    const path = entry.path.replaceAll('\\', '/')
    if (entry.type !== 'File') {
      entry.resume()
      return
    }

    entries.push({ path, read: async () => readCapturedContentData(path, contents) })
    if (!isSessionFileName(path.split('/').pop() ?? '')) {
      entry.resume()
      return
    }

    const chunks: Buffer[] = []
    entry.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    entry.on('end', () => {
      contents.set(path, Buffer.concat(chunks).toString('utf8'))
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      parser.on('end', () => {
        resolve()
      })
      parser.on('error', reject)
      source.on('error', reject)
      source.pipe(parser)
    })
  } catch (error) {
    throw new EnergySourceError(
      `Could not read ${description}: ${error instanceof Error ? error.message : 'the stream failed'}`,
    )
  }

  return entries
}

function readCapturedContentData(path: string, contents: Map<string, string>): string {
  const content = contents.get(path)
  if (content === undefined) {
    throw new Error(`The contents of ${path} were not captured from the tar stream`)
  }
  return content
}
