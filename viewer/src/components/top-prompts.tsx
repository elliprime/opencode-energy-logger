'use client'

import { useEffect, useState, type ReactNode } from 'react'
import {
  listTopPrompts,
  type EnergyFilter,
  type PromptLocation,
  type TopPrompt,
} from '@/lib/energy/stats'
import { formatJoules, formatKwh } from '@/lib/energy/format'
import { annotationKey, type PromptRunAnnotation } from '@/lib/energy/annotations'
import { useReportAnnotations } from './annotations-provider'
import { AnnotationChips } from './annotation-chips'

/** The row counts the report can be set to show. */
const PROMPT_LIMITS = [10, 25, 50, 100] as const

/** Rows beyond this many scroll instead of growing the card. */
const VISIBLE_ROW_LIMIT = 10

interface TopPromptsProps {
  /** The filter restricting which records the report uses. */
  readonly filter: EnergyFilter

  readonly annotationSyncCount: number

  readonly onPromptClick: (prompt: PromptLocation) => void
}

export function TopPrompts({ filter, annotationSyncCount, onPromptClick }: TopPromptsProps) {
  const [prompts, setPrompts] = useState<readonly TopPrompt[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState<number>(10)
  const [rowsContinueBelow, setRowsContinueBelow] = useState(true)
  const { annotations } = useReportAnnotations()

  useEffect(() => {
    let cancelled = false
    listTopPrompts(filter, limit)
      .then(result => {
        if (!cancelled) {
          setPrompts(result)
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
  }, [filter, limit, annotationSyncCount])

  function changeLimit(next: number): void {
    // the new table starts scrolled back at the top, so the fade
    // indicating further rows below applies again
    setRowsContinueBelow(true)
    setLimit(next)
  }

  let body: ReactNode
  if (error !== null) {
    body = (
      <p role="alert" className="text-sm text-red-800">
        {error}
      </p>
    )
  } else if (prompts === null) {
    body = <p className="text-sm text-zinc-500">Computing the top prompts…</p>
  } else if (prompts.length === 0) {
    body = <p className="text-sm text-zinc-500">No prompts in the filtered records.</p>
  } else if (prompts.length <= VISIBLE_ROW_LIMIT) {
    body = <PromptsTable prompts={prompts} annotations={annotations} onFocus={onPromptClick} />
  } else {
    body = (
      <div className="relative">
        <div
          className="max-h-[22.75rem] overflow-y-auto pr-1"
          onScroll={event => {
            const { scrollTop, clientHeight, scrollHeight } = event.currentTarget
            const isThereScrollableContent = scrollTop + clientHeight < scrollHeight - 1
            setRowsContinueBelow(isThereScrollableContent)
          }}
        >
          <PromptsTable
            prompts={prompts}
            annotations={annotations}
            onFocus={onPromptClick}
            stickyHeader
          />
        </div>
        {rowsContinueBelow ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-white to-transparent"
          />
        ) : null}
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">Most expensive prompts</h3>
        <p className="text-xs text-zinc-400">
          the {limit} prompts that used the most energy — each row is one chronology entry, a run of
          consecutive requests with the same prompt, kind and agent. Note: The selected filter applies.
          Click a prompt to scroll to its entry in the chronology below.
        </p>
      </div>
      {body}
      <div className="flex items-center justify-end gap-2">
        <label htmlFor="top-prompts-limit" className="text-xs text-zinc-500">
          prompts shown
        </label>
        <select
          id="top-prompts-limit"
          value={limit}
          onChange={event => changeLimit(Number(event.target.value))}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900"
        >
          {PROMPT_LIMITS.map(count => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
      </div>
    </section>
  )
}

/**
 * The report's table.
 * 
 * `stickyHeader` keeps the column labels in view while the card's rows scroll.
 */
function PromptsTable({
  prompts,
  annotations,
  onFocus,
  stickyHeader = false,
}: {
  readonly prompts: readonly TopPrompt[]
  readonly annotations: ReadonlyMap<string, PromptRunAnnotation>
  readonly onFocus: (focus: PromptLocation) => void
  readonly stickyHeader?: boolean
}) {
  const headerCells = 'sticky top-0 z-10 bg-white'

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-zinc-500">
          <th
            scope="col"
            className={`border-b border-zinc-200 py-1.5 pr-4 text-left font-medium ${stickyHeader ? headerCells : ''}`}
          >
            Prompt
          </th>
          <th
            scope="col"
            className={`border-b border-zinc-200 py-1.5 pr-4 text-left font-medium ${stickyHeader ? headerCells : ''}`}
          >
            Kind
          </th>
          <th
            scope="col"
            className={`border-b border-zinc-200 py-1.5 pr-4 text-left font-medium ${stickyHeader ? headerCells : ''}`}
          >
            Agent
          </th>
          <th
            scope="col"
            className={`border-b border-zinc-200 py-1.5 pr-4 text-left font-medium ${stickyHeader ? headerCells : ''}`}
          >
            Annotations
          </th>
          <th
            scope="col"
            className={`border-b border-zinc-200 py-1.5 text-right font-medium ${stickyHeader ? headerCells : ''}`}
          >
            Energy
          </th>
        </tr>
      </thead>
      <tbody>
        {prompts.map((prompt, index) => {
          const focus = prompt.location
          const text = prompt.prompt === '' ? '(no prompt text)' : prompt.prompt
          const tags =
            focus !== null && prompt.runFirstLogId !== null
              ? annotations.get(annotationKey(focus.sessionId, prompt.runFirstLogId))?.tags ?? []
              : []

          return (
            <tr key={index} className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50">
              <td className="py-1.5 pr-4">
                {focus !== null ? (
                  <button
                    type="button"
                    onClick={() => onFocus(focus)}
                    title={text}
                    className="block max-w-[36rem] truncate rounded text-left text-zinc-700 underline decoration-dotted decoration-zinc-400 underline-offset-2 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
                  >
                    {text}
                  </button>
                ) : (
                  <span className="block max-w-[36rem] truncate text-zinc-700" title={text}>
                    {text}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap py-1.5 pr-4 text-zinc-600">
                {prompt.kind ?? '—'}
              </td>
              <td className="whitespace-nowrap py-1.5 pr-4 text-zinc-600">
                {prompt.agent ?? '—'}
              </td>
              <td className="py-1.5 pr-4">
                <AnnotationChips tags={tags} />
              </td>
              <td
                className="whitespace-nowrap py-1.5 text-right tabular-nums text-zinc-900"
                title={formatJoules(prompt.kwh)}
              >
                {formatKwh(prompt.kwh)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
