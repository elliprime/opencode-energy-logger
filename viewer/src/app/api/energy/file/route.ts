import { connection } from 'next/server'
import { currentAnalysis } from '@/lib/energy/current'

/**
 * Returns the JSONL contents for a single energy file of the directory being
 * analyzed by name (supplied as a query parameter).
 */
export async function GET(request: Request) {
  // the handler reads in-memory state; make sure it always runs at
  // request time instead of being prerendered as a static response.
  await connection()

  const name = new URL(request.url).searchParams.get('name') ?? ''

  const analysis = currentAnalysis()
  if (analysis === null) {
    return Response.json({ error: 'No energy directory is being analyzed' }, { status: 409 })
  }

  // match the exact file name only, so no path can be requested
  for await (const file of analysis.directory) {
    if (file.filename === name) {
      const contents = await file.read()
      return new Response(contents, {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      })
    }
  }

  return Response.json({ error: `Unknown energy file: ${name}` }, { status: 404 })
}
