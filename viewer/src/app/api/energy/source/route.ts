import { energyErrorResponse } from '@/lib/energy/api'
import { analyzeEnergyDirectory } from '@/lib/energy/current'
import { energyDirectoryFromPath } from '@/lib/energy/path'
import { energyDirectoryFromRepositoryUrl } from '@/lib/energy/repository'

/**
 * Sets the energy directory to analyze from a local folder path or a
 * GitHub/Forgejo repository link, and responds with its energy files.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { input?: unknown } | null
  const input = typeof body?.input === 'string' ? body.input.trim() : ''
  if (input.length === 0) {
    return Response.json({ error: 'Enter a local folder path or a repository URL' }, { status: 400 })
  }

  try {
    const directory = isUrlLike(input)
      ? await energyDirectoryFromRepositoryUrl(normalizeUrl(input))
      : await energyDirectoryFromPath(input)
    const filenames = await analyzeEnergyDirectory(input, directory)
    return Response.json({ source: input, filenames })
  } catch (error) {
    return energyErrorResponse(error, `Could not analyze ${input}`)
  }
}

const URL_LIKE = /^(?:https?:\/\/|www\.)|[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i

function isUrlLike(input: string): boolean {
  return URL_LIKE.test(input)
}

function normalizeUrl(input: string): string {
  return /^https?:\/\//i.test(input) ? input : `https://${input}`
}
