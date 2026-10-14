import { EnergySourceError } from './types'

/**
 * maps an error thrown while analyzing an energy directory to a response:
 * expected problems become 400s carrying their message, anything
 * unexpected becomes a logged 500.
 */
export function energyErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof EnergySourceError) {
    return Response.json({ error: error.message }, { status: 400 })
  }

  console.error(error)
  return Response.json({ error: fallback }, { status: 500 })
}
