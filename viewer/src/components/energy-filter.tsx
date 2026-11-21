'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  AnnotationFilterCondition,
  EnergyFilter,
  EnergyFilterCondition,
  EnergyFilterMatch,
  FilterDimension,
} from '@/lib/energy/stats'
import {
  ANNOTATION_DIMENSION,
  isAnnotationCondition,
  isFilterConditionActive,
} from '@/lib/energy/stats'

/** A dimension with few distinct values matches exactly; free text matches as a substring. */
function matchFor(dimensions: readonly FilterDimension[], name: string): EnergyFilterMatch {
  const dimension = dimensions.find(candidate => candidate.name === name)
  return dimension !== undefined && dimension.values !== null ? 'exact' : 'contains'
}

interface EnergyFilterBarProps {
  /** The dimensions the loaded records can be filtered by. */
  readonly dimensions: readonly FilterDimension[]

  /** The filter currently applied to the dashboard. */
  readonly filter: EnergyFilter

  /** Receives the edited filter when the dropdown closes. */
  readonly onChange: (filter: EnergyFilter) => void
}

/**
 * The dashboard's filter dropdown. Collapsed it summarizes the
 * applied dimension/value conditions at its top; expanded it allows editing
 * of the applied filter. For dimensions with few distinct values, a <select>
 * is used, for others a free text input that checks for values that contain
 * what was inputted.
 */
export function EnergyFilterBar({ dimensions, filter, onChange }: EnergyFilterBarProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<readonly EnergyFilterCondition[]>(filter)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    function close(propagateChange: boolean): void {
      setOpen(false)
      if (propagateChange) {
        onChange(draft.filter(isFilterConditionActive))
      }
    }

    function onPointerDown(event: PointerEvent): void {
      if (
        containerRef.current !== null &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        close(false)
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        close(false)
      }
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, draft, onChange])

  function toggle(propagate = false): void {
    if (open) {
      setOpen(false)
      if (propagate) {
        onChange(draft.filter(isFilterConditionActive))
      }
      return
    }

    setDraft(filter)
    setOpen(true)
  }

  function addCondition(): void {
    const dimension = dimensions.find(
      candidate => !draft.some(condition => condition.dimension === candidate.name),
    )
    if (dimension === undefined) {
      return
    }
    setDraft(current => [
      ...current,
      dimension.name === ANNOTATION_DIMENSION
        ? { dimension: ANNOTATION_DIMENSION, values: [] }
        : { dimension: dimension.name, value: '', match: matchFor(dimensions, dimension.name) },
    ])
  }

  const canAddCondition = dimensions.some(
    dimension => !draft.some(condition => condition.dimension === dimension.name),
  )

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => toggle()}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-50"
      >
        <span className="flex-none font-medium text-zinc-700">Filter</span>
        {filter.length === 0 ? (
          <span className="truncate text-zinc-400">none — all records included</span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {filter.map((condition, index) => (
              <span key={index} className="flex items-center gap-1.5">
                {index > 0 ? (
                  <span className="text-xs italic text-zinc-400" title="conditions are AND'ed">
                    and
                  </span>
                ) : null}
                {isAnnotationCondition(condition) ? (
                  <span
                    className="max-w-56 truncate rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700"
                    title={`annotation is any of: ${condition.values.map(value => `"${value}"`).join(', ')}`}
                  >
                    annotation in ({condition.values.join(', ')})
                  </span>
                ) : (
                  <span
                    className="max-w-56 truncate rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700"
                    title={`${condition.dimension} ${condition.match === 'exact' ? 'is' : 'contains'} "${condition.value}"`}
                  >
                    {condition.dimension} {condition.match === 'exact' ? '=' : '~'} {condition.value}
                  </span>
                )}
              </span>
            ))}
          </span>
        )}
        <span className="ml-auto flex-none text-xs text-zinc-400" aria-hidden="true">
          {open ? '▼' : '▶'}
        </span>
      </button>

      {open ? (
        <div className="absolute inset-x-0 top-full z-30 mt-1 rounded-md border border-zinc-200 bg-white p-3 shadow-xl">
          <p className="text-xs text-zinc-500">
            Records enter the dashboard’s metrics when every condition matches — dimensions with
            a value list match exactly, text values match as case-insensitive substrings, and an
            annotation condition matches the prompt runs tagged with any of its values. The
            prompt chronology below always shows every session.
          </p>
          {draft.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No conditions — all records are included.</p>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              {draft.map((condition, index) => (
                <FilterConditionRow
                  key={index}
                  condition={condition}
                  dimensions={dimensions}
                  onChange={updated =>
                    setDraft(current => current.map((c, i) => (i === index ? updated : c)))
                  }
                  onRemove={() => setDraft(current => current.filter((_, i) => i !== index))}
                />
              ))}
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={addCondition}
              disabled={!canAddCondition}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add condition
            </button>
            <button
              type="button"
              onClick={() => toggle(true)}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function FilterConditionRow({
  condition,
  dimensions,
  onChange,
  onRemove,
}: {
  condition: EnergyFilterCondition
  dimensions: readonly FilterDimension[]
  onChange: (condition: EnergyFilterCondition) => void
  onRemove: () => void
}) {
  const dimension = dimensions.find(candidate => candidate.name === condition.dimension)

  // a condition may name a dimension the loaded records no longer
  // carry; keep it selectable so it can still be edited or removed
  const dimensionNames = dimensions.some(candidate => candidate.name === condition.dimension)
    ? dimensions.map(candidate => candidate.name)
    : [condition.dimension, ...dimensions.map(candidate => candidate.name)]

  function selectDimension(name: string): void {
    // one dimension's value means nothing for another, and the new
    // dimension may match by a different mode
    onChange(
      name === ANNOTATION_DIMENSION
        ? { dimension: ANNOTATION_DIMENSION, values: [] }
        : { dimension: name, value: '', match: matchFor(dimensions, name) },
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Dimension"
        value={condition.dimension}
        onChange={event => selectDimension(event.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900"
      >
        {dimensionNames.map(name => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {isAnnotationCondition(condition) ? (
        <AnnotationConditionRow
          condition={condition}
          tags={dimensions.find(candidate => candidate.name === ANNOTATION_DIMENSION)?.values ?? []}
          onChange={onChange}
        />
      ) : dimension !== undefined && dimension.values !== null ? (
        <select
          aria-label="Value"
          value={condition.value}
          onChange={event => onChange({ ...condition, value: event.target.value })}
          className="min-w-40 grow rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900"
        >
          <option value="">Select a value…</option>
          {dimension.values.map(value => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          aria-label="Value"
          value={condition.value}
          placeholder="contains…"
          onChange={event => onChange({ ...condition, value: event.target.value })}
          className="min-w-40 grow rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900"
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove condition"
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-100"
      >
        Remove
      </button>
    </div>
  )
}

/**
 * The editor of an annotation condition: the tags in use as toggle
 * chips, a run matches when it carries any of the selected ones.
 */
function AnnotationConditionRow({ condition, tags, onChange }: {
  condition: AnnotationFilterCondition
  tags: readonly string[]
  onChange: (condition: EnergyFilterCondition) => void
}) {
  function toggleTag(tag: string): void {
    onChange({
      dimension: ANNOTATION_DIMENSION,
      values: condition.values.includes(tag)
        ? condition.values.filter(value => value !== tag)
        : [...condition.values, tag],
    })
  }

  if (tags.length === 0) {
    return (
      <p className="grow text-sm text-zinc-500">
        No annotations yet — tag prompt runs in the chronology below, then filter by them here.
      </p>
    )
  }

  return (
    <div className="flex grow flex-wrap items-center gap-1.5">
      {tags.map(tag => {
        const selected = condition.values.includes(tag)
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={selected}
            onClick={() => toggleTag(tag)}
            title={`runs tagged "${tag}"`}
            className={
              selected
                ? 'rounded-full bg-violet-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-violet-700'
                : 'rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100'
            }
          >
            {tag}
          </button>
        )
      })}
    </div>
  )
}
