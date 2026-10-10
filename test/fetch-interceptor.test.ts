import { afterAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractEnergyFromJsonBody,
  extractUserPrompt,
  installFetchInterceptor,
  isLlmChatUrl,
  parseEnergyComment,
  readStreamBodyJson,
} from '../src/fetch-interceptor.js'
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
})

describe('isLlmChatUrl', () => {
  it('should match chat endpoint URLs in slash and colon form', () => {
    expect(isLlmChatUrl('https://api.openai.com/v1/chat/completions')).toBe(true)
    expect(isLlmChatUrl('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(isLlmChatUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent')).toBe(true)
    expect(isLlmChatUrl('https://aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.0-flash:streamGenerateContent?alt=sse')).toBe(true)
  })

  it('should not match unrelated URLs', () => {
    expect(isLlmChatUrl('https://example.com/api/telemetry')).toBe(false)
    expect(isLlmChatUrl('https://example.com/api/messages-list')).toBe(false)
    expect(isLlmChatUrl('https://example.com/')).toBe(false)
  })
})

describe('readStreamBodyJson', () => {
  it('should resolve the parsed body json when the stream completes', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('\uFEFF{"model":"m"'))
        controller.enqueue(encoder.encode('}'))
        controller.close()
      },
    })
    const { json, cancel } = readStreamBodyJson(stream)
    expect(await json).toEqual({ model: 'm' })
    cancel()
  })

  it('should settle the pending read when cancelled', async () => {
    const stream = new ReadableStream({ start() {} })
    const { json, cancel } = readStreamBodyJson(stream)
    cancel()
    expect(await json).toBeUndefined()
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

function startServer(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

describe('installFetchTap', () => {
  it('should log energy and prompt while passing the stream through untouched', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': energy {"joules_per_token": 0.0012,"request_id":"req_123"}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      setTimeout(() => {
        res.write(': energy {"total_joules": 3.45,"request_id":"req_123"}\n\n')
        res.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n')
        res.end()
      }, 50)
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1/chat/completions`

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'what is the energy cost' }] }),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/event-stream')

      const text = await response.text()
      expect(text).toContain('data: {"choices":[{"delta":{"content":"hi"}}]}')
      expect(text).toContain('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}')
      expect(text).not.toContain('[energy-logger]')

      const entries = await waitForEnergyEntries(entriesBefore + 1)
      expect(entries.length).toBe(entriesBefore + 1)

      const entry = entries[entries.length - 1]
      expect(entry.url).toBe(url)
      expect(entry.model).toBe('test-model')
      expect(entry.prompt).toBe('what is the energy cost')
      expect(entry.energy).toEqual([
        { joules_per_token: 0.0012, request_id: 'req_123' },
        { total_joules: 3.45, request_id: 'req_123' },
      ])
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should log energy from a non-streaming JSON response', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'x', usage: { prompt_tokens: 3 }, energy: { total_joules: 7.5 } }))
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1/chat/completions`

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ model: 'json-model', messages: [{ role: 'user', content: 'plain answer please' }] }),
      })
      expect(await response.json()).toEqual({ id: 'x', usage: { prompt_tokens: 3 }, energy: { total_joules: 7.5 } })

      const entries = await waitForEnergyEntries(entriesBefore + 1)
      const entry = entries[entries.length - 1]
      expect(entries.length).toBe(entriesBefore + 1)
      expect(entry.model).toBe('json-model')
      expect(entry.prompt).toBe('plain answer please')
      expect(entry.energy).toEqual([{ total_joules: 7.5 }])
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should extract energy from a JSON body preceded by whitespace-only chunks', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write(' \n ')
      setTimeout(() => {
        res.end('  {"id":"y","usage":{"prompt_tokens":1},"energy":{"total_joules":9}}')
      }, 25)
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1/chat/completions`

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ model: 'split-model', messages: [{ role: 'user', content: 'split body please' }] }),
      })
      expect(await response.json()).toEqual({ id: 'y', usage: { prompt_tokens: 1 }, energy: { total_joules: 9 } })

      const entries = await waitForEnergyEntries(entriesBefore + 1)
      expect(entries.length).toBe(entriesBefore + 1)

      const entry = entries[entries.length - 1]
      expect(entry.model).toBe('split-model')
      expect(entry.prompt).toBe('split body please')
      expect(entry.energy).toEqual([{ total_joules: 9 }])
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should not log when a chat response contains no energy values', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      res.end()
    })
    const { port } = server.address() as AddressInfo

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'no-energy-model', messages: [{ role: 'user', content: 'nothing to measure' }] }),
      })
      await response.text()
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(energyEntries().length).toBe(entriesBefore)
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should log energy for google-style generateContent calls with energy in a data line', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n')
      res.write('data: {"usage":{"prompt_tokens":5,"energy":{"total_joules":2.5}}}\n\n')
      res.end()
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1beta/models/gemini-2.0-flash:generateContent`

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello gemini' }] }] }),
      })
      expect(response.status).toBe(200)

      const entries = await waitForEnergyEntries(entriesBefore + 1)
      expect(entries.length).toBe(entriesBefore + 1)

      const entry = entries[entries.length - 1]
      expect(entry.url).toBe(url)
      expect(entry.model).toBeUndefined()
      expect(entry.prompt).toBe('hello gemini')
      expect(entry.energy).toEqual([{ total_joules: 2.5 }])
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should log energy for request-object calls to google-style colon URLs', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"usage":{"prompt_tokens":5,"energy":{"total_joules":2.5}}}\n\n')
      res.end()
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse`

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length

    try {
      const request = new Request(url, {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello via request object' }] }] }),
      })
      const response = await fetch(request)
      expect(response.status).toBe(200)

      const entries = await waitForEnergyEntries(entriesBefore + 1)
      expect(entries.length).toBe(entriesBefore + 1)

      const entry = entries[entries.length - 1]
      expect(entry.url).toBe(url)
      expect(entry.prompt).toBe('hello via request object')
      expect(entry.energy).toEqual([{ total_joules: 2.5 }])
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should join data lines of a single SSE event before parsing', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"usage":{"prompt_tokens":5,\n')
      res.write('data: "energy":{"total_joules":4.2}}}\n\n')
      res.end()
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1/chat/completions`

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ model: 'split-model', messages: [{ role: 'user', content: 'joined payload please' }] }),
      })
      expect(response.status).toBe(200)

      const entries = await waitForEnergyEntries(entriesBefore + 1)
      expect(entries.length).toBe(entriesBefore + 1)

      const entry = entries[entries.length - 1]
      expect(entry.model).toBe('split-model')
      expect(entry.energy).toEqual([{ total_joules: 4.2 }])
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should log energy for completion-style bodies without messages via the URL heuristic', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': energy {"total_joules": 9.9}\n\n')
      res.end()
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1/completions`

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ model: 'legacy-model', prompt: 'complete this' }),
      })
      expect(response.status).toBe(200)

      const entries = await waitForEnergyEntries(entriesBefore + 1)
      expect(entries.length).toBe(entriesBefore + 1)

      const entry = entries[entries.length - 1]
      expect(entry.model).toBe('legacy-model')
      expect(entry.prompt).toBeUndefined()
      expect(entry.energy).toEqual([{ total_joules: 9.9 }])
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should log energy for blob request bodies', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': energy {"total_joules": 6.5}\n\n')
      res.end()
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1/chat/completions`

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: new Blob([JSON.stringify({ model: 'blob-model', messages: [{ role: 'user', content: 'blob body please' }] })]),
      })
      expect(response.status).toBe(200)

      const entries = await waitForEnergyEntries(entriesBefore + 1)
      expect(entries.length).toBe(entriesBefore + 1)

      const entry = entries[entries.length - 1]
      expect(entry.model).toBe('blob-model')
      expect(entry.prompt).toBe('blob body please')
      expect(entry.energy).toEqual([{ total_joules: 6.5 }])
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should log energy for arraybuffer request bodies', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': energy {"total_joules": 7.5}\n\n')
      res.end()
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1/chat/completions`

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: new TextEncoder().encode(JSON.stringify({ model: 'buffer-model', messages: [{ role: 'user', content: 'buffer body please' }] })).buffer,
      })
      expect(response.status).toBe(200)

      const entries = await waitForEnergyEntries(entriesBefore + 1)
      expect(entries.length).toBe(entriesBefore + 1)

      const entry = entries[entries.length - 1]
      expect(entry.model).toBe('buffer-model')
      expect(entry.prompt).toBe('buffer body please')
      expect(entry.energy).toEqual([{ total_joules: 7.5 }])
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should log energy for readable-stream request bodies without breaking the upload', async () => {
    const received: string[] = []
    const server = await startServer((req, res) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
      })
      req.on('end', () => {
        received.push(data)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(': energy {"total_joules": 8.5}\n\n')
        res.end()
      })
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1/chat/completions`
    const bodyText = JSON.stringify({ model: 'stream-model', messages: [{ role: 'user', content: 'stream body please' }] })

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length

    try {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(bodyText))
          controller.close()
        },
      })
      const streamInit: RequestInit & { duplex?: 'half' } = { method: 'POST', body: stream, duplex: 'half' }
      const response = await fetch(url, streamInit)
      expect(response.status).toBe(200)
      expect(received[0]).toBe(bodyText)

      const entries = await waitForEnergyEntries(entriesBefore + 1)
      expect(entries.length).toBe(entriesBefore + 1)

      const entry = entries[entries.length - 1]
      expect(entry.model).toBe('stream-model')
      expect(entry.prompt).toBe('stream body please')
      expect(entry.energy).toEqual([{ total_joules: 8.5 }])
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should not log for requests that are not LLM chat calls', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': energy {"total_joules": 1}\n\n')
      res.end()
    })
    const { port } = server.address() as AddressInfo

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length
    try {
      await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'GET' })
      await fetch(`http://127.0.0.1:${port}/telemetry`, {
        method: 'POST',
        body: JSON.stringify({ event: 'pageview' }),
      })
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(energyEntries().length).toBe(entriesBefore)
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should preserve response url, type and redirected through redirects', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/final' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[]}\n\n')
      res.end()
    })

    const { port } = server.address() as AddressInfo
    const finalUrl = `http://127.0.0.1:${port}/final`

    const baseline = await fetch(`http://127.0.0.1:${port}/redirect`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'provenance check' }] }),
    })
    await baseline.text()

    const uninstall = installFetchInterceptor()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/redirect`, {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'provenance check' }] }),
      })

      expect(response.redirected).toBe(true)
      expect(response.url).toBe(finalUrl)
      expect(response.url).toBe(baseline.url)
      expect(response.type).toBe(baseline.type)
      expect(response.redirected).toBe(baseline.redirected)
      expect(Object.keys(response)).toEqual([])
      expect(await response.text()).toContain('data: {"choices":[]}')
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should not log energy when the response stream is aborted mid-scan', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': energy {"joules_per_token": 0.0012}\n\n')
    })

    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1/chat/completions`

    const uninstall = installFetchInterceptor()
    const entriesBefore = energyEntries().length
    const controller = new AbortController()

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ model: 'abort-model', messages: [{ role: 'user', content: 'will be aborted' }] }),
      })
      const reader = response.body!.getReader()
      await reader.read()
      controller.abort()
      await reader.read().catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(energyEntries().length).toBe(entriesBefore)
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should preserve response url, type and redirected on clones of intercepted responses', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/final' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[]}\n\n')
      res.end()
    })

    const { port } = server.address() as AddressInfo
    const finalUrl = `http://127.0.0.1:${port}/final`

    const uninstall = installFetchInterceptor()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/redirect`, {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'clone provenance' }] }),
      })

      const clone = response.clone()
      expect(clone.redirected).toBe(true)
      expect(clone.url).toBe(finalUrl)
      expect(clone.type).toBe(response.type)
      expect(Object.keys(clone)).toEqual([])

      const cloneOfClone = clone.clone()
      expect(cloneOfClone.redirected).toBe(true)
      expect(cloneOfClone.url).toBe(finalUrl)

      expect(await response.text()).toContain('data: {"choices":[]}')
      expect(await clone.text()).toContain('data: {"choices":[]}')
      expect(await cloneOfClone.text()).toContain('data: {"choices":[]}')
    } finally {
      uninstall()
      server.close()
    }
  })

  it('should cancel the request-body capture when the wrapped fetch fails', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      void (init?.body as ReadableStream | undefined)?.cancel()
      return Promise.reject(new TypeError('fetch failed'))
    }) as typeof fetch

    const uninstall = installFetchInterceptor()

    try {
      let sourceCancelled = false
      const stream = new ReadableStream({
        start() {},
        cancel() {
          sourceCancelled = true
        },
      })
      const streamInit: RequestInit & { duplex?: 'half' } = { method: 'POST', body: stream, duplex: 'half' }
      await expect(fetch('http://localhost/v1/chat/completions', streamInit)).rejects.toThrow('fetch failed')
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(sourceCancelled).toBe(true)
    } finally {
      uninstall()
      globalThis.fetch = originalFetch
    }
  })

  it('should restore the original fetch on uninstall', () => {
    const before = globalThis.fetch
    const uninstall = installFetchInterceptor()
    try {
      expect(globalThis.fetch).not.toBe(before)
    } finally {
      uninstall()
    }
    expect(globalThis.fetch).toBe(before)
  })
})
