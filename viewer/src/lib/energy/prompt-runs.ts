/**
 * Functions around prompt runs: consecutive requests within one session
 * that share a prompt, kind and agent — the queries one agent loop made
 * to fulfill that prompt.
 */

/**
 * A DuckDB row that can be collapsed into a prompt run.
 */
export interface PromptRunRow {
  readonly sessionId: string
  readonly id: string | null
  readonly kind: string | null
  readonly agent: string | null
  readonly prompt: string | null
}

export type PromptRun<Row extends PromptRunRow> = Omit<Row, 'id'> & {
  /** How many rows the run collapsed; 1 when nothing collapsed. */
  readonly logs: number
  readonly ids: readonly string[]
}

/**
 * Collapses the chronological request rows into prompt runs: a
 * run of consecutive requests within one session with the same agent,
 * kind and prompt is one agent loop working through one prompt, and
 * becomes one entry carrying the run's totals. A new prompt, a
 * compaction, a different agent or a new session breaks the run and
 * starts a new entry.
 *
 * Note: this expects rows to be sorted by session ID and time.
 */
export function collapsePromptRuns<Row extends PromptRunRow>(rows: readonly Row[]): PromptRun<Row>[] {
  const entries: PromptRun<Row>[] = []

  for (const row of rows) {
    const previous = entries[entries.length - 1]
    if (
      previous !== undefined &&
      previous.sessionId === row.sessionId &&
      previous.agent === row.agent &&
      previous.kind === row.kind &&
      previous.prompt === row.prompt
    ) {
      entries[entries.length - 1] = {
        ...addMetricsTo(previous, row),
        logs: previous.logs + 1,
        ids: row.id !== null ? [...previous.ids, row.id] : previous.ids,
      }
    } else {
      const { id, ...scalars } = row
      entries.push({
        ...scalars,
        logs: 1,
        ids: id !== null ? [id] : [],
      })
    }
  }

  return entries
}

function addMetricsTo<Row extends PromptRunRow>(entry: PromptRun<Row>, rowToAdd: Row): PromptRun<Row> {
  const totals: Record<string, unknown> = { ...entry }
  for (const [key, value] of Object.entries(rowToAdd)) {
    if (typeof value === 'number') { // check if this value is a metric
      const total = totals[key]
      totals[key] = (typeof total === 'number' ? total : 0) + value
    }
  }
  return totals as PromptRun<Row>
}
