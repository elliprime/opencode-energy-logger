/**
 * Prompt-run annotations.
 *
 * Prompt texts cannot be categorized deterministically, so the user
 * tags the prompt runs of the chronology while analyzing: an
 * annotation is a set of simple tags ("review", "refactor", …) on one
 * prompt run — a run of consecutive requests within a session sharing
 * a prompt, kind and agent.
 *
 * Annotations are stored in the browser's localStorage per analyzed
 * source, so they survive app and server restarts: DuckDB only ever
 * holds a mirror of them that the filter conditions and the raw data
 * view query (see `syncPromptAnnotations`).
 */

/** The annotations of one prompt run. */
export interface PromptRunAnnotation {
  /** The session the run belongs to. */
  readonly sessionId: string

  /**
   * The first log id of the run . The rest of the run's log ids are re-derived
   * from the loaded records when the annotation is mirrored into DuckDB, so it
   * keeps covering the whole run even as the analyzed source grows.
   */
  readonly logId: string

  readonly tags: readonly string[]
}

/** The prefix of every annotation storage key, versioned with the stored shape. */
const STORAGE_PREFIX = 'energy-annotations.v1'

function storageKey(logSource: string): string {
  return `${STORAGE_PREFIX}:${logSource.trim()}`
}

export function annotationKey(sessionId: string, firstLogId: string): string {
  return `${sessionId}/${firstLogId}`
}

/** A trimmed tag, or null when the value holds none. */
export function normalizeTag(value: string): string | null {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length === 0 ? null : trimmed
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** One stored annotation as saved in localStorage, before validation. */
interface StoredAnnotation {
  readonly sessionId?: unknown
  readonly logId?: unknown
  readonly tags?: unknown
}

/**
 * The annotations of one source as stored, keyed by `annotationKey`.
 * Unreadable shapes and incomplete entries are skipped rather than
 * failing the load.
 */
function parseAnnotations(text: string | null): Map<string, PromptRunAnnotation> {
  const annotations = new Map<string, PromptRunAnnotation>()
  if (text === null) {
    return annotations
  }

  let stored: unknown
  try {
    stored = JSON.parse(text)
  } catch {
    return annotations
  }

  if (!Array.isArray(stored)) {
    return annotations
  }

  for (const entry of stored as StoredAnnotation[]) {
    if (entry === null || typeof entry !== 'object') {
      continue
    }

    const tags = Array.isArray(entry.tags) ? entry.tags.filter(isNonEmptyString) : []
    if (isNonEmptyString(entry.sessionId) && isNonEmptyString(entry.logId) && tags.length > 0) {
      annotations.set(annotationKey(entry.sessionId, entry.logId), {
        sessionId: entry.sessionId,
        logId: entry.logId,
        tags,
      })
    }
  }

  return annotations
}

export function loadAnnotations(source: string): ReadonlyMap<string, PromptRunAnnotation> {
  if (typeof window === 'undefined') { // sanity check
    return new Map()
  }

  try {
    return parseAnnotations(window.localStorage.getItem(storageKey(source)))
  } catch {
    return new Map()
  }
}

/**
 * Persists a source's annotations. A failure (e.g. the storage quota)
 * keeps them in the session's state — they just will not survive a
 * restart.
 */
export function saveAnnotations(source: string, annotations: ReadonlyMap<string, PromptRunAnnotation>): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(storageKey(source), JSON.stringify([...annotations.values()]))
  } catch (caught) {
    // the annotations live on in this session's state
    console.error(
      `Failed to save annotations in local storage: ${
        caught instanceof Error ? (caught.stack ?? caught.message) : String(caught)
      }`,
    )
  }
}
