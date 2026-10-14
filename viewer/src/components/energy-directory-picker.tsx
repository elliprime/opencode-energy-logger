'use client'

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { EnergyFileList } from './energy-file-list'

interface Analysis {
  source: string
  filenames: string[]
}

const BUTTON_CLASS =
  'self-start rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50'

const TEXT_INPUT_CLASS =
  'w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500'

export function EnergyDirectoryPicker() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sourceInput, setSourceInput] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/energy/files', { signal: controller.signal })
      .then(response => response.json())
      .then((data: { source: string | null; filenames: string[] }) => {
        if (data.source !== null) {
          setAnalysis({ source: data.source, filenames: data.filenames })
        }
      })
      .catch(() => {})

    return () => {
      controller.abort()
    }
  }, [])

  async function analyze(request: () => Promise<Response>) {
    setBusy(true)
    setError(null)

    try {
      const response = await request()
      const body: { source?: string; filenames?: string[]; error?: string } | null = await response
        .json()
        .catch(() => null)

      if (!response.ok) {
        throw new Error(body?.error ?? `The request failed (${response.status})`)
      }

      if (typeof body?.source !== 'string' || !Array.isArray(body.filenames)) {
        throw new Error('The server sent an unexpected response')
      }

      setAnalysis({ source: body.source, filenames: body.filenames })
    } catch (caught) {
      setAnalysis(null)
      setError(caught instanceof Error ? caught.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null)
    setError(null)
  }

  function clearFile() {
    setFile(null)
    if (fileInput.current !== null) {
      fileInput.current.value = ''
    }
    setError(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (file !== null) {
      const archive = file
      await analyze(() => {
        const data = new FormData()
        data.append('file', archive)
        return fetch('/api/energy/archive', { method: 'POST', body: data })
      })
      return
    }

    const input = sourceInput.trim()
    if (input.length === 0) {
      setError('Choose an archive file or enter a local folder path or repository URL')
      return
    }

    await analyze(() =>
      fetch('/api/energy/source', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
      }),
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-xs"
      >
        <h2 className="text-sm font-semibold text-zinc-900">Choose an energy directory</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <input
              type="text"
              value={file !== null ? file.name : sourceInput}
              onChange={event => setSourceInput(event.target.value)}
              placeholder="~/projects/my-repo · https://github.com/owner/my-repo"
              disabled={busy || file !== null}
              className={`${TEXT_INPUT_CLASS} ${file !== null ? 'pr-9' : ''}`}
            />
            {file !== null ? (
              <button
                type="button"
                onClick={clearFile}
                aria-label="Clear the selected file"
                disabled={busy}
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-700"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            ) : null}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.tar.gz,.tgz"
            disabled={busy}
            onChange={handleFileChange}
            className="w-full text-sm text-zinc-700 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-800 hover:file:bg-zinc-200 sm:w-auto sm:flex-none"
          />
        </div>
        <p className="text-xs text-zinc-500">
          A local folder, a GitHub or Forgejo repository link, or a .zip or .tar.gz archive containing
          a .energy folder or ses_*.jsonl files.
        </p>
        <button type="submit" disabled={busy} className={BUTTON_CLASS}>
          Analyze
        </button>
      </form>

      {busy ? <p className="text-sm text-zinc-500">Analyzing…</p> : null}
      {error !== null ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {analysis !== null ? <EnergyFileList source={analysis.source} filenames={analysis.filenames} /> : null}
    </div>
  )
}
