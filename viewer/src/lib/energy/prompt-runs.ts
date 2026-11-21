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

export interface RunMembershipRow extends PromptRunRow {
  readonly time: string | null
}

/** The fields that decide which prompt run a row belongs to. */
interface RunIdentity {
  readonly sessionId: string
  readonly kind: string | null
  readonly agent: string | null
  readonly prompt: string | null
}

/** Whether two chronological rows belong to the same prompt run. */
function sameRun(left: RunIdentity, right: RunIdentity): boolean {
  return (
    left.sessionId === right.sessionId
    && left.agent === right.agent
    && left.kind === right.kind
    && left.prompt === right.prompt
  )
}

/**
 * Returns an array mapping the index of a energy log row (from rows) with the
 * log ID of the first row in the prompt run the aforementioned log belongs to.
 */
export function findRunFirstLogIds(rows: readonly RunMembershipRow[]): Array<string | null> {
  const order = rows.map((_, index) => index)
  order.sort((left, right) => compareChronologically(rows[left], rows[right]))

  const firstLogIds: Array<string | null> = rows.map(() => null)

  let members: number[] = []

  // sets the first log ID for every member of the current run
  const finishRun = () => {
    const firstId = members.map(index => rows[index].id).find(id => id !== null) ?? null
    for (const index of members) {
      firstLogIds[index] = firstId
    }
    members = []
  }

  for (const index of order) {
    if (members.length > 0 && sameRun(rows[members[0]], rows[index])) {
      members.push(index)
    } else {
      finishRun()
      members = [index]
    }
  }
  finishRun()
  return firstLogIds
}

function compareChronologically(left: RunMembershipRow, right: RunMembershipRow): number {
  if (left.sessionId !== right.sessionId) {
    return left.sessionId < right.sessionId ? -1 : 1
  }
  return compareTime(left.time, right.time) || compareLogId(left.id, right.id)
}

function compareTime(left: string | null, right: string | null): number {
  if (left === right) {
    return 0
  }

  if (left === null) {
    return -1
  }
  
  if (right === null) {
    return 1
  }

  // ISO timestamps compare as instants (DuckDB reads them as
  // TIMESTAMP); anything else stays the plain string it was logged as
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return left < right ? -1 : 1
  }
  return leftTime - rightTime
}

function compareLogId(left: string | null, right: string | null): number {
  if (left === right) {
    return 0
  }
  if (left === null) {
    return -1
  }
  if (right === null) {
    return 1
  }
  return left < right ? -1 : 1
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
    if (previous !== undefined && sameRun(previous, row)) {
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
