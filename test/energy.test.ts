import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureEnergyFromResponse,
  extractEnergyFromJsonBody,
  extractUserPrompt,
  parseEnergyComment,
} from '../src/energy.js'
import { logFilePath } from '../src/log.js'

const stateDir = mkdtempSync(join(tmpdir(), 'energy-logger-test-'))
process.env.XDG_STATE_HOME = stateDir

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('parseEnergyComment', () => {
  it('should parse a well-formed energy comment line', () => {
    expect(parseEnergyComment(': energy {"total_joules": 3.45}')).toEqual({ total_joules: 3.45 })
  })

  it('should parse an energy comment line with carriage return', () => {
    expect(parseEnergyComment(': energy {"total_joules": 3.45}\r')).toEqual({ total_joules: 3.45 })
  })

  it('should return undefined for non-energy comment lines', () => {
    expect(parseEnergyComment(': ping')).toBeUndefined()
    expect(parseEnergyComment(':energy {"a":1}')).toEqual({ a: 1 })
    expect(parseEnergyComment('data: {"energy":1}')).toBeUndefined()
    expect(parseEnergyComment('')).toBeUndefined()
  })

  it('should return undefined for non-JSON payloads', () => {
    expect(parseEnergyComment(': energy not-json')).toBeUndefined()
    expect(parseEnergyComment(': energy {broken')).toBeUndefined()
  })
})

describe('extractEnergyFromJsonBody', () => {
  it('should extract a top-level energy field from a JSON body', () => {
    expect(extractEnergyFromJsonBody('{"model":"m","energy":{"total_joules":1}}')).toEqual([{ total_joules: 1 }])
  })

  it('should extract energy from the usage field of a JSON body', () => {
    expect(extractEnergyFromJsonBody('{"usage":{"prompt_tokens":2,"energy":{"joules":9}}}')).toEqual([{ joules: 9 }])
  })

  it('should return an empty array for SSE text and invalid JSON', () => {
    expect(extractEnergyFromJsonBody('data: {"energy":1}\n\n')).toEqual([])
    expect(extractEnergyFromJsonBody('not json')).toEqual([])
    expect(extractEnergyFromJsonBody('[1,2]')).toEqual([])
  })

  it('should return an empty array for JSON payloads without an energy field', () => {
    expect(extractEnergyFromJsonBody('{"choices":[]}')).toEqual([])
    expect(extractEnergyFromJsonBody('{"usage":{"prompt_tokens":2}}')).toEqual([])
  })

  it('should skip energy fields that are null', () => {
    expect(extractEnergyFromJsonBody('{"energy":null}')).toEqual([])
    expect(extractEnergyFromJsonBody('{"usage":{"energy":null}}')).toEqual([])
    expect(extractEnergyFromJsonBody('{"energy":null,"usage":{"energy":{"joules":9}}}')).toEqual([{ joules: 9 }])
    expect(extractEnergyFromJsonBody('{"energy":0}')).toEqual([0])
  })

  it('should prefer the top-level energy field when usage also carries one', () => {
    expect(extractEnergyFromJsonBody('{"energy":{"total_joules":1},"usage":{"energy":{"total_joules":2}}}')).toEqual([{ total_joules: 1 }])
  })
})

describe('extractUserPrompt', () => {
  it('should extract the last user message with string content', () => {
    const body = {
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second question' },
      ],
    }
    expect(extractUserPrompt(body)).toBe('second question')
  })

  it('should join text parts of multipart content', () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] }] }
    expect(extractUserPrompt(body)).toBe('part one\npart two')
  })

  it('should extract from google-style contents', () => {
    const body = { contents: [{ role: 'model', parts: [{ text: 'hi' }] }, { role: 'user', parts: [{ text: 'hello' }] }] }
    expect(extractUserPrompt(body)).toBe('hello')
  })

  it('should return undefined when there is no user message', () => {
    expect(extractUserPrompt({ messages: [{ role: 'system', content: 'x' }] })).toBeUndefined()
    expect(extractUserPrompt('nope')).toBeUndefined()
  })
})

function readLog(): string {
  try {
    return readFileSync(logFilePath(), 'utf8')
  } catch {
    return ''
  }
}

function energyEntries(): Record<string, unknown>[] {
  return readLog()
    .split('\n')
    .filter(line => line.includes('"type":"energy"'))
    .map(line => JSON.parse(line.slice(line.indexOf('[energy-logger] ') + '[energy-logger] '.length)))
}

async function waitForEnergyEntries(expectedCount: number): Promise<Record<string, unknown>[]> {
  const start = Date.now()
  while (Date.now() - start < 2000) {
    const entries = energyEntries()
    if (entries.length >= expectedCount) {
      return entries
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${expectedCount} energy entries, log contains:\n${readLog()}`)
}

const encoder = new TextEncoder()

function sseStream(chunks: readonly string[], delayMs = 0): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
      }
      controller.close()
    },
  })
}

function modelRequest(url: string, body: unknown, headers?: Record<string, string>): Request {
  return new Request(url, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function modelResponse(body: ReadableStream<Uint8Array> | string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

describe('captureEnergyFromResponse', () => {
  it('should log energy and prompt from an SSE response while leaving the response body readable', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'what is the energy cost' }],
    })
    const response = modelResponse(sseStream([
      ': energy {"joules_per_token": 0.0012,"request_id":"req_123"}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      ': energy {"total_joules": 3.45,"request_id":"req_123"}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
    ], 25), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_1', request, response })

    const text = await response.text()
    expect(text).toContain('data: {"choices":[{"delta":{"content":"hi"}}]}')
    expect(text).toContain('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}')

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    expect(entries.length).toBe(entriesBefore + 1)

    const entry = entries[entries.length - 1]
    expect(entry.url).toBe(url)
    expect(entry.sessionID).toBe('ses_1')
    expect(entry.model).toBe('test-model')
    expect(entry.prompt).toBe('what is the energy cost')
    expect(entry.energy).toEqual([
      { joules_per_token: 0.0012, request_id: 'req_123' },
      { total_joules: 3.45, request_id: 'req_123' },
    ])
  })

  it('should log energy from a non-streaming JSON response', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'json-model',
      messages: [{ role: 'user', content: 'plain answer please' }],
    })
    const response = modelResponse(
      JSON.stringify({ id: 'x', usage: { prompt_tokens: 3 }, energy: { total_joules: 7.5 } }),
      'application/json',
    )

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_2', request, response })
    expect(await response.json()).toEqual({ id: 'x', usage: { prompt_tokens: 3 }, energy: { total_joules: 7.5 } })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entries.length).toBe(entriesBefore + 1)
    expect(entry.model).toBe('json-model')
    expect(entry.prompt).toBe('plain answer please')
    expect(entry.energy).toEqual([{ total_joules: 7.5 }])
  })

  it('should extract energy from a JSON body preceded by whitespace-only chunks', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'split-model',
      messages: [{ role: 'user', content: 'split body please' }],
    })
    const response = modelResponse(sseStream([
      ' \n ',
      '  {"id":"y","usage":{"prompt_tokens":1},"energy":{"total_joules":9}}',
    ], 25), 'application/json')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_3', request, response })
    expect(await response.json()).toEqual({ id: 'y', usage: { prompt_tokens: 1 }, energy: { total_joules: 9 } })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    expect(entries.length).toBe(entriesBefore + 1)

    const entry = entries[entries.length - 1]
    expect(entry.model).toBe('split-model')
    expect(entry.prompt).toBe('split body please')
    expect(entry.energy).toEqual([{ total_joules: 9 }])
  })

  it('should not log when a response contains no energy values', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'no-energy-model',
      messages: [{ role: 'user', content: 'nothing to measure' }],
    })
    const response = modelResponse(sseStream([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_4', request, response })
    await response.text()
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(energyEntries().length).toBe(entriesBefore)
  })

  it('should not log when the only energy value is null', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'null-energy-model',
      messages: [{ role: 'user', content: 'no measurement' }],
    })
    const response = modelResponse(sseStream([
      'data: {"energy":null}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_19', request, response })
    await response.text()
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(energyEntries().length).toBe(entriesBefore)
  })

  it('should log energy from a data line for google-style contents bodies', async () => {
    const url = 'http://127.0.0.1:1/v1beta/models/gemini-2.0-flash:generateContent'
    const request = modelRequest(url, {
      contents: [{ role: 'user', parts: [{ text: 'hello gemini' }] }],
    })
    const response = modelResponse(sseStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n',
      'data: {"usage":{"prompt_tokens":5,"energy":{"total_joules":2.5}}}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({
      sessionID: 'ses_5',
      model: { providerID: 'google', id: 'gemini-2.0-flash' },
      request,
      response,
    })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.url).toBe(url)
    expect(entry.model).toBe('google/gemini-2.0-flash')
    expect(entry.prompt).toBe('hello gemini')
    expect(entry.energy).toEqual([{ total_joules: 2.5 }])
  })

  it('should join data lines of a single SSE event before parsing', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'split-model',
      messages: [{ role: 'user', content: 'joined payload please' }],
    })
    const response = modelResponse(sseStream([
      'data: {"usage":{"prompt_tokens":5,\n',
      'data: "energy":{"total_joules":4.2}}}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_6', request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.model).toBe('split-model')
    expect(entry.energy).toEqual([{ total_joules: 4.2 }])
  })

  it('should log energy in stream order when a data line precedes an energy comment in the same event', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'interleave-model',
      messages: [{ role: 'user', content: 'interleaved data please' }],
    })
    const response = modelResponse(sseStream([
      'data: {"usage":{"energy":{"n":1}}}\n: energy {"n":2}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_19', request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.energy).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('should log energy in stream order when an energy comment precedes a data line in the same event', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'interleave-comment-model',
      messages: [{ role: 'user', content: 'interleaved comment please' }],
    })
    const response = modelResponse(sseStream([
      ': energy {"n":2}\ndata: {"usage":{"energy":{"n":1}}}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_20', request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.energy).toEqual([{ n: 2 }, { n: 1 }])
  })

  it('should log each data payload separately around an interleaved energy comment', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'interleave-multi-model',
      messages: [{ role: 'user', content: 'separate payloads please' }],
    })
    const response = modelResponse(sseStream([
      'data: {"energy":{"n":1}}\n: energy {"n":3}\ndata: {"energy":{"n":2}}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_21', request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.energy).toEqual([{ n: 1 }, { n: 3 }, { n: 2 }])
  })

  it('should record only the comment energy when an energy comment splits a payload spanning data lines', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'interleave-split-model',
      messages: [{ role: 'user', content: 'split payload please' }],
    })
    const response = modelResponse(sseStream([
      'data: {"usage":{"prompt_tokens":5,\n: energy {"n":2}\ndata: "energy":{"total_joules":4.2}}}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_22', request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.energy).toEqual([{ n: 2 }])
  })

  it('should log energy from a CR-only SSE stream', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'cr-model',
      messages: [{ role: 'user', content: 'carriage returns only' }],
    })
    const response = modelResponse(sseStream([
      ': energy {"total_joules": 1.5}\r',
      'data: {"usage":{"energy":{"total_joules": 2.5}}}\r\r',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_13', request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.energy).toEqual([{ total_joules: 1.5 }, { total_joules: 2.5 }])
  })

  it('should log energy from a CRLF SSE stream', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'crlf-model',
      messages: [{ role: 'user', content: 'windows line endings' }],
    })
    const response = modelResponse(sseStream([
      ': energy {"total_joules": 3.5}\r\n',
      '\r\n',
      'data: {"usage":{"prompt_tokens":5,"energy":{"total_joules": 4.5}}}\r\n',
      '\r\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_14', request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.energy).toEqual([{ total_joules: 3.5 }, { total_joules: 4.5 }])
  })

  it('should reassemble an event when a chunk boundary splits a CRLF line ending', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'split-crlf-model',
      messages: [{ role: 'user', content: 'split crlf please' }],
    })
    const response = modelResponse(sseStream([
      'data: {"usage":{"prompt_tokens":5,\r',
      '\ndata: "energy":{"total_joules":4.2}}}\r',
      '\n\r\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_15', request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.energy).toEqual([{ total_joules: 4.2 }])
  })

  it('should log energy for completion-style bodies without user messages', async () => {
    const url = 'http://127.0.0.1:1/v1/completions'
    const request = modelRequest(url, { model: 'legacy-model', prompt: 'complete this' })
    const response = modelResponse(sseStream([
      ': energy {"total_joules": 9.9}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_7', request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.model).toBe('legacy-model')
    expect(entry.prompt).toBeUndefined()
    expect(entry.energy).toEqual([{ total_joules: 9.9 }])
  })

  it('should log energy for request bodies delivered as a stream', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const bodyText = JSON.stringify({
      model: 'stream-model',
      messages: [{ role: 'user', content: 'stream body please' }],
    })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(bodyText))
        controller.close()
      },
    })
    const streamInit: RequestInit & { duplex?: 'half' } = { method: 'POST', body: stream, duplex: 'half' }
    const request = new Request(url, streamInit)
    const response = modelResponse(sseStream([
      ': energy {"total_joules": 8.5}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_8', request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.model).toBe('stream-model')
    expect(entry.prompt).toBe('stream body please')
    expect(entry.energy).toEqual([{ total_joules: 8.5 }])
  })

  it('should omit the sessionID field when the event has none', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'anon-model',
      messages: [{ role: 'user', content: 'no session' }],
    })
    const response = modelResponse(sseStream([
      ': energy {"total_joules": 1.5}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ request, response })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.sessionID).toBeUndefined()
    expect(entry.energy).toEqual([{ total_joules: 1.5 }])
  })

  it('should prefer the hook event model over the request body model', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'body-model',
      messages: [{ role: 'user', content: 'which model is this' }],
    })
    const response = modelResponse(sseStream([
      ': energy {"total_joules": 2.2}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({
      sessionID: 'ses_11',
      model: { providerID: 'neuralwatt', id: 'ref-model', variant: 'thinking' },
      request,
      response,
    })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.model).toBe('neuralwatt/ref-model#thinking')
    expect(entry.prompt).toBe('which model is this')
    expect(entry.energy).toEqual([{ total_joules: 2.2 }])
  })

  it('should record kind and agent from the hook event', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'kind-model',
      messages: [{ role: 'user', content: 'compact this conversation' }],
    })
    const response = modelResponse(sseStream([
      ': energy {"total_joules": 4.4}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({
      sessionID: 'ses_12',
      agent: 'build',
      kind: 'compaction',
      request,
      response,
    })

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.kind).toBe('compaction')
    expect(entry.agent).toBe('build')
    expect(entry.energy).toEqual([{ total_joules: 4.4 }])
  })

  it('should not log energy when the response stream is aborted mid-scan', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'abort-model',
      messages: [{ role: 'user', content: 'will be aborted' }],
    })
    const response = modelResponse(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': energy {"joules_per_token": 0.0012}\n\n'))
        controller.error(new Error('aborted'))
      },
    }), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_9', request, response })
    await response.text().catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(energyEntries().length).toBe(entriesBefore)
  })

  it('should skip responses without a body', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'empty-model',
      messages: [{ role: 'user', content: 'nothing comes back' }],
    })
    const response = new Response(null, { status: 204 })

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_10', request, response })
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(energyEntries().length).toBe(entriesBefore)
  })

  it('should include the branch in the record when provided', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'branch-model',
      messages: [{ role: 'user', content: 'which branch is this' }],
    })
    const response = modelResponse(sseStream([
      ': energy {"total_joules": 5.5}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_16', request, response }, () => Promise.resolve('feature/energy'))

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.branch).toBe('feature/energy')
    expect(entry.energy).toEqual([{ total_joules: 5.5 }])
  })

  it('should not invoke the branch read when no energy values are found', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'lazy-model',
      messages: [{ role: 'user', content: 'nothing to measure' }],
    })
    const response = modelResponse(sseStream([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    ]), 'text/event-stream')

    const readBranch = vi.fn(async () => 'feature/energy')
    await captureEnergyFromResponse({ sessionID: 'ses_18', request, response }, readBranch)

    expect(readBranch).not.toHaveBeenCalled()
  })

  it('should omit the branch when it resolves to undefined', async () => {
    const url = 'http://127.0.0.1:1/v1/chat/completions'
    const request = modelRequest(url, {
      model: 'no-branch-model',
      messages: [{ role: 'user', content: 'no branch here' }],
    })
    const response = modelResponse(sseStream([
      ': energy {"total_joules": 6.5}\n\n',
    ]), 'text/event-stream')

    const entriesBefore = energyEntries().length
    await captureEnergyFromResponse({ sessionID: 'ses_17', request, response }, () => Promise.resolve(undefined))

    const entries = await waitForEnergyEntries(entriesBefore + 1)
    const entry = entries[entries.length - 1]
    expect(entry.branch).toBeUndefined()
    expect(entry.energy).toEqual([{ total_joules: 6.5 }])
  })
})
