import { createHash } from 'node:crypto'
import { appendEnergyRecord } from './energy.store.js'
import { debug } from './log.js'

const ENERGY_COMMENT = /^:\s*energy\s*/

// SSE lines may be terminated by CRLF, LF, or a lone CR
const LINE_BREAK = /\r\n|\r|\n/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function parseEnergyComment(line: string): unknown {
  const match = ENERGY_COMMENT.exec(line)
  if (!match) {
    return undefined
  }

  const payload = line.slice(match[0].length).trim()
  if (!payload.startsWith('{')) {
    return undefined
  }

  return tryParseJson(payload)
}

function energyFromRecord(parsed: unknown): unknown[] {
  if (!isRecord(parsed)) {
    return []
  }

  // `energy` is the canonical measurement and `usage.energy` its fallback;
  // when both carry a value only the canonical one is recorded. a null field
  // means the provider has nothing to report and is not treated a measurement.
  const value = parsed.energy ?? (isRecord(parsed.usage) ? parsed.usage.energy : undefined)
  return value === undefined || value === null ? [] : [value]
}

export function extractEnergyFromJsonBody(text: string): unknown[] {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.includes('"energy"')) {
    return []
  }

  return energyFromRecord(tryParseJson(trimmed))
}

function messageText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const parts = content
      .filter(part => isRecord(part) && typeof part.text === 'string')
      .map(part => part.text)

    if (parts.length > 0) {
      return parts.join('\n')
    }
  }

  return undefined
}

export function extractUserPrompt(bodyJson: unknown): string | undefined {
  if (!isRecord(bodyJson)) {
    return undefined
  }

  for (const propertyName of ['messages', 'contents']) {
    const messages = bodyJson[propertyName]

    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (!isRecord(message) || message.role !== 'user') {
          continue
        }

        const text = messageText(message.content ?? message.parts)
        if (text === undefined) {
          continue
        }

        return text
      }
    }
  }

  return undefined
}

/** Formats a model reference the same way Model.Ref.parse reads it. */
function formatModelRef(ref: { providerID: string, id: string, variant?: string } | undefined): string | undefined {
  if (ref === undefined) {
    return undefined
  }

  return ref.variant ? `${ref.providerID}/${ref.id}#${ref.variant}` : `${ref.providerID}/${ref.id}`
}

/**
 * Serializes a value with object keys sorted and undefined entries dropped,
 * so equal records serialize identically no matter the key order.
 *
 * Values nested deeper than five levels serialize as null: no record is that
 * deep, and the bound keeps an arbitrarily deep energy payload from
 * exhausting the call stack.
 */
function stableStringify(value: unknown, depth = 1): string {
  if (depth > 5) {
    return 'null'
  }

  if (Array.isArray(value)) {
    const items = Array.from(value, item => stableStringify(item, depth + 1))
    return `[${items.join(',')}]`
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    const body = entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry, depth + 1)}`)
      .join(',')
    return `{${body}}`
  }

  return JSON.stringify(value) ?? 'null'
}

export function recordId(record: Record<string, unknown>): string {
  const rest = { ...record }
  delete rest.id
  return createHash('md5').update(stableStringify(rest)).digest('hex')
}

/**
 * Scans a model response body for energy values, returned in stream order.
 *
 * Returns undefined when the scan could not complete (for example an aborted
 * stream); an empty array means the body contained no energy values.
 */
async function scanResponseStream(stream: ReadableStream<Uint8Array>): Promise<unknown[] | undefined> {
  const energies: unknown[] = []
  const reader = stream.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  let full = ''
  let couldBeJsonBody: boolean | undefined
  let dataLines: string[] = []
  let scanCompleted = false

  const accumulateFull = (text: string) => {
    // check if the response starts with '{'
    if (couldBeJsonBody === undefined) {
      const trimmed = text.trimStart()
      if (trimmed.length === 0) {
        return // nothing but whitespace so far, wait for more data
      }
      couldBeJsonBody = trimmed[0] === '{'
    }

    if (couldBeJsonBody && energies.length === 0) {
      // keep track of the whole text in case it is a JSON value with an `energy` property
      full += text
    }
  }

  const checkDataLinesConcatted = () => {
    if (dataLines.length === 0) {
      return
    }

    energies.push(...extractEnergyFromJsonBody(dataLines.join('\n')))
    dataLines = []
  }

  const processLine = (line: string) => {
    if (line === '') {
      checkDataLinesConcatted()
      return
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length))
      return
    }

    const energy = parseEnergyComment(line)
    if (energy !== undefined) {
      // flush data lines queued earlier in this event so energies land in
      // stream order (data lines split around the comment are not joined,
      // we do not handle this abnormality)
      checkDataLinesConcatted()
      energies.push(energy)
    }
  }

  // splits complete lines out of the buffer and processes them
  const processLines = (final: boolean) => {
    while (true) {
      const match = LINE_BREAK.exec(buffer)
      if (match === null) {
        return // no line breaks
      }

      if (!final && match[0] === '\r' && match.index + 1 === buffer.length) {
        // string ends on a carriage return and there may be more data. we stop
        // early in case the \n is the next byte in the stream.
        return
      }

      const line = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)

      processLine(line)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      const text = decoder.decode(value, { stream: true })
      buffer += text
      accumulateFull(text)

      processLines(false)
    }

    const tail = decoder.decode()
    buffer += tail
    accumulateFull(tail)

    processLines(true)

    if (buffer.length > 0) {
      processLine(buffer)
    }

    checkDataLinesConcatted()

    if (couldBeJsonBody && energies.length === 0) {
      // no energy values found in each chunk, try looking for values
      // in the full body
      energies.push(...extractEnergyFromJsonBody(full))
    }

    scanCompleted = true
  } catch (error) {
    debug(`response scan failed: ${String(error)}`)
  }

  if (!scanCompleted) {
    return undefined
  }

  return energies
}

/**
 * Captures energy values from a model HTTP response.
 *
 * The request and response are cloned before any awaiting so the caller can
 * keep consuming the original bodies undisturbed. The record is mirrored
 * into the repository's `.energy` directory when `repoRoot` is given.
 * Never throws.
 */
export async function captureEnergyFromResponse(
  input: {
    sessionID?: string
    agent?: string
    kind?: 'primary' | 'compaction' | 'title' | 'generate'
    model?: { providerID: string, id: string, variant?: string }
    request: Request
    response: Response
  },
  getBranch?: () => Promise<string | undefined>,
  repoRoot?: string,
): Promise<void> {
  const { sessionID, agent, kind, model: modelRef, request, response } = input

  if (
    response.body === null
    || response.status === 204
    || response.status === 205
    || response.status === 304
  ) {
    return
  }

  let responseClone: Response
  try {
    responseClone = response.clone()
  } catch (error) {
    debug(`response clone failed: ${String(error)}`)
    return
  }

  let requestClone: Request | undefined
  try {
    requestClone = request.body === null ? undefined : request.clone()
  } catch (error) {
    debug(`request clone failed: ${String(error)}`)
  }

  const energies = await scanResponseStream(responseClone.body!)
  if (energies === undefined) {
    return
  }

  if (energies.length === 0) {
    debug(`no energy found for ${request.url}`)
    return
  }

  let bodyJson: unknown
  if (requestClone !== undefined) {
    try {
      bodyJson = tryParseJson(await requestClone.text())
    } catch (error) {
      debug(`request body read failed: ${String(error)}`)
    }
  }

  const model = formatModelRef(modelRef)
    ?? (isRecord(bodyJson) && typeof bodyJson.model === 'string' ? bodyJson.model : undefined)

  const branchName = getBranch === undefined ? undefined : await getBranch()

  // the capture runs detached from the response hook, so nothing here may
  // throw: a record that cannot be built or written is dropped instead
  try {
    const time = new Date().toISOString()
    const prompt = extractUserPrompt(bodyJson)

    const record = {
      type: 'energy',
      time,
      ...(sessionID !== undefined ? { sessionID } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(branchName !== undefined ? { branch: branchName } : {}),
      url: request.url,
      model,
      prompt,
      energy: energies,
    }

    appendEnergyRecord({ ...record, id: recordId(record) }, repoRoot)
  } catch (error) {
    debug(`energy record write failed: ${String(error)}`)
  }
}
