'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  annotationKey,
  loadAnnotations,
  saveAnnotations,
  type PromptRunAnnotation,
} from '@/lib/energy/annotations'

interface AnnotationsContextValue {
  /** Every annotation, keyed by `annotationKey` (session + first log id). */
  readonly annotations: ReadonlyMap<string, PromptRunAnnotation>
 
  /** The distinct tags in use, sorted. */
  readonly knownTags: readonly string[]

  /**
   * Replaces the tags of one prompt run — an empty tag list removes
   * the annotation.
   */
  readonly setRunTags: (
    sessionId: string,
    logIds: readonly string[],
    tags: readonly string[],
  ) => void

  /** Removes every annotation of the analysis. */
  readonly clearAll: () => void
}

const AnnotationsContext = createContext<AnnotationsContextValue | null>(null)

/**
 * Holds the annotations of one analysis. Remounted per analysis (the
 * parent passes a `key`), so the state always belongs to the source
 * being viewed.
 */
export function AnnotationsProvider({ source, children }: {
  readonly source: string
  readonly children: ReactNode
}) {
  const [runs, setRuns] = useState<ReadonlyMap<string, PromptRunAnnotation>>(() =>
    loadAnnotations(source),
  )

  const setRunTags = useCallback(
    (sessionId: string, logIds: readonly string[], tags: readonly string[]) => {
      setRuns(current => {
        if (logIds.length === 0) {
          return current
        }

        const next = new Map(current)
        const key = annotationKey(sessionId, logIds[0])
        if (tags.length === 0) {
          next.delete(key)
        } else {
          next.set(key, { sessionId, logIds, tags })
        }
        saveAnnotations(source, next)
        return next
      })
    },
    [source],
  )

  const clearAll = useCallback(() => {
    setRuns(() => {
      saveAnnotations(source, new Map())
      return new Map()
    })
  }, [source])

  const tags = useMemo(() => {
    const seen = new Set<string>()
    const distinct: string[] = []
    for (const annotation of runs.values()) {
      for (const tag of annotation.tags) {
        const key = tag.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          distinct.push(tag)
        }
      }
    }
    return distinct.sort((a, b) => a.localeCompare(b))
  }, [runs])

  const value = useMemo(
    () => ({ runs, tags, setRunTags, clearAll }),
    [runs, tags, setRunTags, clearAll],
  )

  return <AnnotationsContext.Provider value={value}>{children}</AnnotationsContext.Provider>
}

export function useReportAnnotations(): AnnotationsContextValue {
  const context = useContext(AnnotationsContext)
  if (context === null) {
    throw new Error('useReportAnnotations must be used within an AnnotationsProvider')
  }
  return context
}
