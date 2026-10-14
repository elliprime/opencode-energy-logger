import type { EnergyDirectory } from './types'

interface CurrentAnalysis {
  /**
   * A human readable description of where the energy directory came
   * from, e.g. the archive file name or the entered path or URL.
   */
  readonly source: string
  readonly directory: EnergyDirectory
}

let current: CurrentAnalysis | null = null

/**
 * The energy directory currently being analyzed, or null when nothing
 * was set yet.
 */
export function currentAnalysis(): CurrentAnalysis | null {
  return current
}

/**
 * Sets the energy directory to analyze and returns the names of its
 * files.
 */
export async function analyzeEnergyDirectory(source: string, directory: EnergyDirectory): Promise<string[]> {
  current = { source, directory }
  return energyFileNames(directory)
}

/**
 * The sorted names of the energy files in a directory.
 */
export async function energyFileNames(directory: EnergyDirectory): Promise<string[]> {
  const names: string[] = []
  for await (const file of directory) {
    names.push(file.filename)
  }
  return names.sort()
}
