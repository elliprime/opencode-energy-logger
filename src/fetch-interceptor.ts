import { debug, log } from './log.js'

const ENERGY_COMMENT = /^:\s*energy\s*/
const CHAT_URL = /[/:](chat\/completions|completions|messages|generateContent|streamGenerateContent)(?:\/|\?|$)/

type CallInfo = {
  url: string
  method: string
  bodyJson?: unknown
  bodyText?: string
  bodyJsonLater?: Promise<unknown>
}

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

function parseChatBodyJson(text: string): unknown {
  if (!text.includes('"messages"') && !text.includes('"contents"')) {
    return undefined
  }
  return tryParseJson(text)
}

export function isLlmChatUrl(url: string): boolean {
  return CHAT_URL.test(url)
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

  const found: unknown[] = []
  if ('energy' in parsed) {
    found.push(parsed.energy)
  }
  if (isRecord(parsed.usage) && 'energy' in parsed.usage) {
    found.push(parsed.usage.energy)
  }
  return found
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

function isLlmChatCall(info: CallInfo): boolean {
  if (info.method !== 'POST') {
    return false
  }

  if (isRecord(info.bodyJson)) {
    return Array.isArray(info.bodyJson.messages) || Array.isArray(info.bodyJson.contents)
  }

  return isLlmChatUrl(info.url)
}

export function readStreamBodyJson(stream: ReadableStream<Uint8Array>): { json: Promise<unknown>, cancel: () => void } {
  const reader = stream.getReader()
  const decoder = new TextDecoder()

  const json = (async () => {
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      text += decoder.decode(value, { stream: true })
    }

    text += decoder.decode()

    if (text.startsWith('\uFEFF')) {
      text = text.slice(1)
    }

    return tryParseJson(text)
  })().catch(() => undefined)

  return {
    json,
    cancel() {
      void reader.cancel().catch(() => undefined)
    },
  }
}

function captureRequest(input: Parameters<typeof fetch>[0], init?: RequestInit): { info: CallInfo, init?: RequestInit, cancelCapture?: () => void } {
  const info: CallInfo = { url: '', method: 'GET' }

  let cancelCapture: (() => void) | undefined

  try {
    if (typeof input === 'string' || input instanceof URL) {
      info.url = input.toString()
      info.method = (init?.method ?? 'GET').toUpperCase()
      const body = init?.body
      if (typeof body === 'string') {
        info.bodyText = body
        info.bodyJson = parseChatBodyJson(body)
      } else if (body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof DataView) {
        info.bodyText = new TextDecoder().decode(body)
        info.bodyJson = parseChatBodyJson(info.bodyText)
      } else if (body instanceof URLSearchParams) {
        info.bodyText = body.toString()
        info.bodyJson = parseChatBodyJson(info.bodyText)
      } else if (body instanceof Blob) {
        if (info.method === 'POST' && isLlmChatUrl(info.url)) {
          info.bodyJsonLater = body.text()
            .then((text: string) => tryParseJson(text))
            .catch(() => undefined)
        }
      } else if (body instanceof ReadableStream) {
        if (info.method === 'POST' && isLlmChatUrl(info.url)) {
          const [forFetch, forUs] = body.tee()
          const capture = readStreamBodyJson(forUs)

          init = { ...init, body: forFetch }
          info.bodyJsonLater = capture.json

          cancelCapture = capture.cancel
        }
      }
    } else {
      info.url = input.url
      info.method = input.method.toUpperCase()

      // only clone/parse requests that look like LLM chat requests
      // note: we clone the input to clone the body stream, so we can
      // read the clone in full (in the background), while the original
      // fetch still consumes its own undisturbed body of the copy.
      if (info.method === 'POST' && isLlmChatUrl(info.url)) {
        const clone = input.clone()
        if (clone.body !== null) {
          const capture = readStreamBodyJson(clone.body)
          info.bodyJsonLater = capture.json
          cancelCapture = capture.cancel
        }
      }
    }
  } catch (error) {
    debug(`request capture failed: ${String(error)}`)
  }
  return { info, init, cancelCapture }
}

async function scanBody(info: CallInfo, stream: ReadableStream<Uint8Array>): Promise<void> {
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
    if (line === '' || line === '\r') {
      checkDataLinesConcatted()
      return
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length))
      return
    }

    const energy = parseEnergyComment(line)
    if (energy !== undefined) {
      energies.push(energy)
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

      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)

        processLine(line)
      }
    }

    const tail = decoder.decode()
    buffer += tail
    accumulateFull(tail)

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
    debug(`scan of ${info.url} failed: ${String(error)}`)
  }

  if (!scanCompleted) {
    return
  }

  if (energies.length === 0) {
    debug(`no energy found for ${info.url}`)
    return
  }

  const bodyJson = info.bodyJson
    ?? (info.bodyText !== undefined ? tryParseJson(info.bodyText) : undefined)
    ?? (await info.bodyJsonLater)
  const model = isRecord(bodyJson) && typeof bodyJson.model === 'string' ? bodyJson.model : undefined
  const record = {
    type: 'energy',
    url: info.url,
    model,
    prompt: extractUserPrompt(bodyJson),
    energy: energies,
  }

  log(JSON.stringify(record))
}

function copyProvenance(from: Response, to: Response): void {
  try {
    for (const key of ['url', 'type', 'redirected'] as const) {
      Object.defineProperty(to, key, {
        value: from[key],
        writable: false,
        enumerable: false,
        configurable: true,
      })
    }
  } catch (error) {
    debug(`provenance copy failed: ${String(error)}`)
  }
}

function shadowClone(from: Response, to: Response): void {
  try {
    const originalClone = to.clone.bind(to)
    Object.defineProperty(to, 'clone', {
      value: () => {
        const cloned = originalClone()
        copyProvenance(from, cloned)
        shadowClone(from, cloned)
        return cloned
      },
      writable: false,
      enumerable: false,
      configurable: true,
    })
  } catch (error) {
    debug(`clone shadow failed: ${String(error)}`)
  }
}

function checkResponse(info: CallInfo, response: Response): Response {
  if (
    response.body === null
    || response.status === 204
    || response.status === 205
    || response.status === 304
  ) {
    return response
  }

  const [forCaller, forUs] = response.body.tee()
  void scanBody(info, forUs)

  const rebuilt = new Response(forCaller, response)
  copyProvenance(response, rebuilt)
  shadowClone(response, rebuilt)
  return rebuilt
}

export function installFetchInterceptor(): () => void {
  const realFetch = globalThis.fetch
  if (typeof realFetch !== 'function') {
    return () => {}
  }

  const wrapper: typeof fetch = async (input, init) => {
    const { info, init: fetchInit, cancelCapture } = captureRequest(input, init)

    let response: Response
    try {
      response = await realFetch(input, fetchInit)
    } catch (error) {
      cancelCapture?.()
      throw error
    }

    if (isLlmChatCall(info)) {
      return checkResponse(info, response)
    }

    return response
  }

  globalThis.fetch = wrapper

  return () => {
    if (globalThis.fetch === wrapper) {
      globalThis.fetch = realFetch
    }
  }
}
