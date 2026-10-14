/**
 * A single session's energy record file (`ses_*.jsonl`).
 */
export interface EnergyFile {
  /**
   * The name of the file, e.g. `ses_1e2f3g4h5i6j7k8l.jsonl`.
   */
  readonly filename: string

  /**
   * Reads the full contents of the file: JSONL, one record per line.
   */
  read(): Promise<string>
}

/**
 * A directory of energy files: an uploaded archive, a local folder or a
 * repository that contains a `.energy` folder or `ses_*.jsonl` files.
 *
 * Just an iterator of the energy files it holds.
 */
export interface EnergyDirectory {
  [Symbol.asyncIterator](): AsyncIterableIterator<EnergyFile>
}

/**
 * An error analyzing an energy directory, with a message that is safe to
 * show in the UI.
 */
export class EnergySourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnergySourceError'
  }
}
