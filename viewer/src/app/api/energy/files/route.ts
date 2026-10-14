import { connection } from 'next/server'
import { currentAnalysis, energyFileNames } from '@/lib/energy/current'

/**
 * The names of the energy files of the energy directory currently being
 * analyzed.
 */
export async function GET() {
  // the handler reads in-memory state; make sure it always runs at
  // request time instead of being prerendered as a static response.
  await connection()

  const analysis = currentAnalysis()
  if (analysis === null) {
    return Response.json({ source: null, filenames: [] })
  }
  return Response.json({ source: analysis.source, filenames: await energyFileNames(analysis.directory) })
}
