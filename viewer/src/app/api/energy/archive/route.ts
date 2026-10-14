import { energyDirectoryFromArchive } from '@/lib/energy/archive'
import { energyErrorResponse } from '@/lib/energy/api'
import { analyzeEnergyDirectory } from '@/lib/energy/current'

/**
 * Handles an archive upload (.zip or .tar.gz) for analysis. Sets it as the energy
 * directory that is being analyzed and responds with its energy files.
 */
export async function POST(request: Request) {
  let file: File | null = null
  try {
    const form = await request.formData()
    const value = form.get('file')
    if (value instanceof File && value.size > 0) {
      file = value
    }
  } catch {
    // handled below
  }

  if (file === null) {
    return Response.json({ error: 'Upload an archive file (.zip or .tar.gz) to analyze' }, { status: 400 })
  }

  try {
    const data = Buffer.from(await file.arrayBuffer())
    const directory = await energyDirectoryFromArchive(data)
    const filenames = await analyzeEnergyDirectory(file.name, directory)
    return Response.json({ source: file.name, filenames })
  } catch (error) {
    return energyErrorResponse(error, `Could not analyze the archive ${file.name}`)
  }
}
