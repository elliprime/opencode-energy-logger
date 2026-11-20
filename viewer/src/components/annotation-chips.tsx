'use client'

import type { ReactNode } from 'react'

export function AnnotationChips({ tags, onRemoveTag }: {
  readonly tags: readonly string[]
  readonly onRemoveTag?: (tag: string) => void
}): ReactNode {
  if (tags.length === 0) {
    return null
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {tags.map(tag => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800"
          title={`annotation: ${tag}`}
        >
          {tag}
          {onRemoveTag !== undefined ? (
            <button
              type="button"
              onClick={() => onRemoveTag(tag)}
              aria-label={`Remove the tag ${tag}`}
              className="rounded-full text-violet-500 transition-colors hover:text-violet-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-600"
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
    </span>
  )
}
