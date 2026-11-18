'use client'

import { useEffect, useState, type ReactNode } from 'react'
import {
  getEnergyRecords,
  listSessionPrompts,
  listSessions,
  type SessionPrompt,
  type SessionSummary,
} from '@/lib/energy/stats'
import { formatCarbon, formatJoules, formatKwh } from '@/lib/energy/format'

const TIMELINE_DOT_COLORS: Record<string, string> = {
  primary: 'bg-emerald-600',
  title: 'bg-amber-500',
  compaction: 'bg-sky-500',
}

const TIMELINE_BADGE_COLORS: Record<string, string> = {
  primary: 'bg-emerald-100 text-emerald-800',
  title: 'bg-amber-100 text-amber-800',
  compaction: 'bg-sky-100 text-sky-800',
}

interface SessionPrompts {
  readonly sessionId: string
  readonly prompts: readonly SessionPrompt[]
}

/** The fetched records of one timeline entry, kept while the chronology lives. */
interface RecordLoadResult {
  readonly records: readonly Record<string, unknown>[] | null
  readonly error: string | null
}

export function PromptChronology() {
  const [sessions, setSessions] = useState<readonly SessionSummary[] | null>(null)
  const [selected, setSelected] = useState('')
  const [loaded, setLoaded] = useState<SessionPrompts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openRecordId, setOpenRecordId] = useState<string | null>(null)
  const [recordLoads, setRecordLoads] = useState<ReadonlyMap<string, RecordLoadResult>>(new Map())

  useEffect(() => {
    let cancelled = false
    listSessions()
      .then(result => {
        if (!cancelled) {
          setSessions(result)
        }
      })
      .catch(caught => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Something went wrong')
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (selected === '') {
      return
    }

    let cancelled = false
    listSessionPrompts(selected)
      .then(result => {
        if (!cancelled) {
          setLoaded({ sessionId: selected, prompts: result })
        }
      })
      .catch(caught => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Something went wrong')
        }
      })

    return () => {
      cancelled = true
    }
  }, [selected])

  const prompts = loaded !== null && loaded.sessionId === selected ? loaded.prompts : null

  function toggleRecord(prompt: SessionPrompt): void {
    if (prompt.ids.length === 0) {
      return
    }

    const key = prompt.ids[0]
    setOpenRecordId(current => (current === key ? null : key))
    if (!recordLoads.has(key)) {
      getEnergyRecords(prompt.ids)
        .then(records => {
          setRecordLoads(loads => new Map(loads).set(key, { records, error: null }))
        })
        .catch(caught => {
          setRecordLoads(loads =>
            new Map(loads).set(key, {
              records: null,
              error: caught instanceof Error ? caught.message : 'Something went wrong',
            }),
          )
        })
    }
  }

  let body: ReactNode
  if (error !== null) {
    body = (
      <p role="alert" className="text-sm text-red-800">
        {error}
      </p>
    )
  } else if (selected === '') {
    body = <p className="text-sm text-zinc-500">Select a session to list its prompts.</p>
  } else if (prompts === null) {
    body = <p className="text-sm text-zinc-500">Loading prompts…</p>
  } else if (prompts.length === 0) {
    body = <p className="text-sm text-zinc-500">This session has no prompts.</p>
  } else {
    body = (
      <div className="h-[28rem] overflow-y-auto pr-1">
        <ol className="ml-1.5 flex flex-col gap-5 border-l-2 border-zinc-200 pl-5">
          {prompts.map((prompt, index) => (
            <li key={prompt.ids[0] ?? index} className="relative">
              <span
                aria-hidden="true"
                className={`absolute -left-[27px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-white ${
                  TIMELINE_DOT_COLORS[prompt.kind ?? ''] ?? 'bg-zinc-400'
                }`}
              />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {prompt.ids.length > 0 ? (
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => toggleRecord(prompt)}
                          aria-expanded={openRecordId === prompt.ids[0]}
                          title="Toggle the full energy records"
                          className="rounded text-xs tabular-nums text-zinc-500 underline decoration-dotted decoration-zinc-400 underline-offset-2 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
                        >
                          <time>{formatTimestamp(prompt.time)}</time>
                        </button>
                        {openRecordId === prompt.ids[0] ? (
                          <RecordPopover load={recordLoads.get(prompt.ids[0])} />
                        ) : null}
                      </div>
                    ) : (
                      <time className="text-xs tabular-nums text-zinc-500">
                        {formatTimestamp(prompt.time)}
                      </time>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        TIMELINE_BADGE_COLORS[prompt.kind ?? ''] ?? 'bg-zinc-100 text-zinc-700'
                      }`}
                    >
                      {prompt.kind ?? 'unknown'}
                    </span>
                    {prompt.logs > 1 ? (
                      <span
                        className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600"
                        title={`${prompt.logs} logs collapsed into this entry`}
                      >
                        ×{prompt.logs}
                      </span>
                    ) : null}
                    {prompt.model !== null ? (
                      <span
                        className="truncate font-mono text-xs text-zinc-500"
                        title={prompt.model}
                      >
                        {prompt.model}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1.5 line-clamp-3 text-sm text-zinc-700" title={prompt.prompt ?? undefined}>
                    {prompt.prompt ?? '(no prompt text)'}
                  </p>
                </div>
                <div className="flex-none text-right" title={energyTitle(prompt)}>
                  <span className="text-sm font-medium text-zinc-900">
                    {formatKwh(prompt.kwh)}
                  </span>
                  <span className="block text-xs text-zinc-500">
                    {formatJoules(prompt.kwh)}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900">Prompt chronology</h3>
        <select
          aria-label="Session"
          value={selected}
          onChange={event => setSelected(event.target.value)}
          disabled={sessions === null}
          className="max-w-xs truncate rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900"
        >
          <option value="">
            {sessions !== null && sessions.length === 0 ? 'No sessions' : 'Select a session…'}
          </option>
          {(sessions ?? []).map(session => (
            <option key={session.sessionId} value={session.sessionId}>
              {session.sessionId} ({session.requests}{' '}
              {session.requests === 1 ? 'request' : 'requests'})
            </option>
          ))}
        </select>
      </div>
      {body}
    </section>
  )
}

/** The full records behind one entry, shown as prettified JSON. */
function RecordPopover({ load }: { load: RecordLoadResult | undefined }) {
  let content: string
  if (load === undefined) {
    content = 'Loading the records…'
  } else if (load.error !== null) {
    content = load.error
  } else if (load.records === null) {
    content = 'No records found.'
  } else {
    content = JSON.stringify(load.records, null, 2)
  }

  return (
    <div
      role="dialog"
      aria-label="Energy record"
      className="absolute left-0 top-7 z-20 w-[32rem] max-w-[calc(100vw-4rem)] rounded-md border border-zinc-200 bg-white shadow-xl"
    >
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md p-3 font-mono text-xs leading-relaxed text-zinc-700">
        {content}
      </pre>
    </div>
  )
}

function energyTitle(prompt: SessionPrompt): string {
  const parts = [formatKwh(prompt.kwh), formatJoules(prompt.kwh)]
  if (prompt.carbonG !== null) {
    parts.push(formatCarbon(prompt.carbonG))
  }
  if (prompt.samples > 0) {
    parts.push(`${prompt.samples} samples`)
  }
  if (prompt.logs > 1) {
    parts.push(`${prompt.logs} logs`)
  }
  if (prompt.agent !== null) {
    parts.push(`agent ${prompt.agent}`)
  }
  return parts.join(' · ')
}

/**
 * DuckDB renders timestamps as `2026-11-15 09:44:24`; parse them back
 * as the UTC instants they were recorded as.
 */
function formatTimestamp(value: string | null): string {
  if (value === null) {
    return '—'
  }
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}
