import { JOULES_PER_KWH } from './format'
import { queryEnergy } from './perspective'

export interface EnergyTotals {
  readonly requests: number
  readonly sessions: number
  readonly samples: number
  readonly totalKwh: number
  readonly totalCarbonG: number | null
  readonly totalDurationSeconds: number | null
  readonly firstDay: string | null
  readonly lastDay: string | null
  /** Distinct (session, prompt) pairs among the records the per-prompt average counts. */
  readonly promptCount: number
  /** Total energy of the records the per-prompt average counts. */
  readonly promptEnergyKwh: number
}

/** Energy grouped by a record field, e.g. model or agent. */
export interface GroupEnergy {
  readonly label: string
  readonly kwh: number
  readonly carbonG: number | null
  readonly samples: number
}

export interface DashboardStats {
  readonly totals: EnergyTotals
  readonly byModel: readonly GroupEnergy[]
  readonly byAgent: readonly GroupEnergy[]
}

/** One session of the loaded records, for the chronology's session picker. */
export interface SessionSummary {
  readonly sessionId: string
  readonly requests: number
  readonly firstTime: string | null
}

/**
 * One request of a session as the chronology query returns it, before
 * collapsing.
 */
interface PromptRow {
  readonly sessionId: string
  readonly id: string | null
  readonly time: string | null
  readonly kind: string | null
  readonly model: string | null
  readonly agent: string | null
  readonly prompt: string | null
  readonly kwh: number
  readonly carbonG: number | null
  readonly samples: number
}

/**
 * A row that can collapse into a prompt run: the fields that decide
 * which run a row belongs to.
 */
interface PromptRunRow {
  readonly sessionId: string
  readonly id: string | null
  readonly kind: string | null
  readonly agent: string | null
  readonly prompt: string | null
}

/**
 * One collapsed run of rows: the scalar fields describe the run's
 * first row, the metric fields total the whole run, and `logs` counts
 * the rows — `ids` lists their logs in order. Which fields are metrics
 * is the row's to say: every field the rows carry numbers in.
 */
type PromptRun<Row extends PromptRunRow> = Omit<Row, 'id'> & {
  /** How many rows the run collapsed; 1 when nothing collapsed. */
  readonly logs: number
  readonly ids: readonly string[]
}

/**
 * One chronology entry: the requests of one run — consecutive requests
 * within one session with the same agent, kind and prompt, the queries
 * one agent loop made to fulfill that prompt — collapsed into a single
 * entry, their metrics totaled.
 */
export type SessionPrompt = PromptRun<PromptRow>

/**
 * The location of a prompt in the chronology of a session.
 */
export interface PromptLocation {
  readonly sessionId: string
  readonly logId: string
}

/**
 * Represents one of the most expensive (in terms of energy consumption) chronology entries.
 */
export interface TopPrompt {
  readonly prompt: string
  readonly kind: string | null
  readonly agent: string | null
  readonly kwh: number

  /** The entry's place in the chronology; null when its logs carry no ids. */
  readonly location: PromptLocation | null
}

/**
 * The expression summing to kWh per sample, or null if the records
 * carry neither of the two known energy fields. The columns can be
 * VARCHAR when the records disagree on a field's type — a value that
 * does not read as a number becomes NULL and drops out of the sums
 * instead of failing the query.
 */
function energyExpression(columns: Set<string>): string | null {
  if (columns.has('energy_kwh')) {
    return 'try_cast(energy_kwh AS DOUBLE)'
  }
  if (columns.has('energy_joules')) {
    return 'try_cast(energy_joules AS DOUBLE) / 3600000.0'
  }
  return null
}

/**
 * A numeric column read as a double, tolerating a VARCHAR column if found.
 */
function numericExpression(column: string): string {
  return `try_cast(${column} AS DOUBLE)`
}

function sumAs(expression: string | null, alias: string): string {
  return expression === null ? `NULL AS ${alias}` : `COALESCE(SUM(${expression}), 0) AS ${alias}`
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return typeof value === 'string' ? value : String(value)
}

/** Energy grouped by a record field, both must exist as columns. */
async function groupBy(
  column: string,
  energy: string,
  carbon: string | null,
  filter: EnergyFilter,
): Promise<GroupEnergy[]> {
  const { condition, params } = samplesFilter(filter)
  const rows = await queryEnergy(`
    SELECT
      ${column} AS label,
      COALESCE(SUM(${energy}), 0) AS kwh,
      ${sumAs(carbon, 'carbon_g')},
      CAST(COUNT(*) AS INT) AS samples
    FROM energy_samples
    ${whereSql([`${column} IS NOT NULL`, condition])}
    GROUP BY ${column}
    ORDER BY kwh DESC
  `, params)

  return rows.map(row => ({
    label: toStringValue(row['label']),
    kwh: toNumber(row['kwh']),
    carbonG: toNumberOrNull(row['carbon_g']),
    samples: toNumber(row['samples']),
  }))
}

/**
 * A record whose total energy falls below this is considered negligible and
 * is left out of the average energy per prompt: the tool-issued
 * session-title requests fall below it while a compaction prompt
 * does not.
 */
const NEGLIGIBLE_ENERGY_KWH = 1000 / JOULES_PER_KWH

/**
 * The aggregates the dashboard tab shows. Must only be called after
 * `loadEnergyFiles` filled the tables.
 */
export async function computeDashboardStats(filter: EnergyFilter = []): Promise<DashboardStats> {
  const described = await queryEnergy('DESCRIBE energy_samples;')
  const columns = new Set(described.map(row => String(row['column_name'])))

  const energy = energyExpression(columns)
  if (energy === null) {
    throw new Error('The loaded energy records contain no energy measurements')
  }
  const carbon = columns.has('carbon_g_co2eq') ? numericExpression('carbon_g_co2eq') : null
  const duration = columns.has('duration_seconds') ? numericExpression('duration_seconds') : null

  const describedEvents = await queryEnergy('DESCRIBE energy_events;')
  const eventColumns = new Set(describedEvents.map(row => String(row['column_name'])))
  const samples = samplesFilter(filter)
  const events = eventsFilter(filter, eventColumns)

  const [totalRows, countRows, promptRows, byModel, byAgent] = await Promise.all([
    queryEnergy(`
      SELECT
        CAST(COUNT(*) AS INT) AS samples,
        COALESCE(SUM(${energy}), 0) AS total_kwh,
        ${sumAs(carbon, 'total_carbon_g')},
        ${sumAs(duration, 'total_duration_seconds')},
        CAST(MIN(strftime(try_cast(time AS TIMESTAMP), '%Y-%m-%d')) AS VARCHAR) AS first_day,
        CAST(MAX(strftime(try_cast(time AS TIMESTAMP), '%Y-%m-%d')) AS VARCHAR) AS last_day
      FROM energy_samples
      ${whereSql([samples.condition])}
    `, samples.params),
    queryEnergy(`
      SELECT
        CAST(COUNT(*) AS INT) AS requests,
        CAST(COUNT(DISTINCT session_id) AS INT) AS sessions
      FROM energy_events
      ${whereSql([events.condition])}
    `, events.params),
    queryEnergy(`
      WITH log_energy AS (
        SELECT energy_log_id AS id, COALESCE(SUM(${energy}), 0) AS kwh
        FROM energy_samples
        GROUP BY energy_log_id
      )
      SELECT
        COALESCE(SUM(log_energy.kwh), 0) AS prompt_energy_kwh,
        CAST(COUNT(DISTINCT (session_id, prompt)) AS INT) AS prompts
      FROM energy_events
      JOIN log_energy ON log_energy.id = energy_log_id
      ${whereSql(['prompt IS NOT NULL', 'log_energy.kwh >= ?', events.condition])}
    `, [NEGLIGIBLE_ENERGY_KWH, ...events.params]),
    groupBy('model', energy, carbon, filter),
    groupBy('agent', energy, carbon, filter),
  ])

  const totalsRow = totalRows[0]
  const countRow = countRows[0]

  return {
    totals: {
      requests: toNumber(countRow?.['requests']),
      sessions: toNumber(countRow?.['sessions']),
      samples: toNumber(totalsRow?.['samples']),
      totalKwh: toNumber(totalsRow?.['total_kwh']),
      totalCarbonG: toNumberOrNull(totalsRow?.['total_carbon_g']),
      totalDurationSeconds: toNumberOrNull(totalsRow?.['total_duration_seconds']),
      firstDay: totalsRow?.['first_day'] === undefined ? null : String(totalsRow['first_day']),
      lastDay: totalsRow?.['last_day'] === undefined ? null : String(totalsRow['last_day']),
      promptCount: toNumber(promptRows[0]?.['prompts']),
      promptEnergyKwh: toNumber(promptRows[0]?.['prompt_energy_kwh']),
    },
    byModel,
    byAgent,
  }
}

/** How a filter condition's value matches: exactly, or as a substring. */
export type EnergyFilterMatch = 'exact' | 'contains'

/** One condition of the dashboard filter: a dimension and the value it must match. */
export interface EnergyFilterCondition {
  readonly dimension: string
  readonly value: string
  readonly match: EnergyFilterMatch
}

/** The dashboard's filter: its conditions are AND'ed together. */
export type EnergyFilter = readonly EnergyFilterCondition[]

/**
 * A column the records can be filtered by. Dimensions with few
 * distinct values carry them for use in a select input; the others are
 * matched by free text.
 */
export interface FilterDimension {
  readonly name: string
  readonly values: readonly string[] | null
}

/**
 * Columns that measure rather than describe — plus the keys and
 * timestamps — are never offered as filter dimensions.
 */
const NON_DIMENSION_COLUMNS = new Set([
  'type',
  'time',
  'energy_log_id',
  'energy_samples',
  'energy_joules',
  'energy_kwh',
  'avg_power_watts',
  'duration_seconds',
  'attribution_method',
  'attribution_ratio',
  'carbon_g_co2eq',
  'grid_carbon_intensity_gco2perkwhr',
  'grid_id',
  'carbon_source',
])

/** A dimension with more distinct values than this is matched by free text. */
const LIMITED_VALUE_COUNT = 25

/** Dimension names are interpolated into SQL, so they must look like identifiers. */
const DIMENSION_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/

/** A filter's conditions as SQL, with its bound parameters. */
interface FilterSql {
  readonly condition: string
  readonly params: string[]
}

function activeConditions(filter: EnergyFilter): readonly EnergyFilterCondition[] {
  return filter.filter(condition => condition.value !== '')
}

function dimensionClause(condition: EnergyFilterCondition): string {
  if (!DIMENSION_NAME_PATTERN.test(condition.dimension)) {
    throw new Error(`Invalid filter dimension: ${condition.dimension}`)
  }
  return condition.match === 'exact'
    ? `LOWER(${condition.dimension}) = ?`
    : `LOWER(${condition.dimension}) LIKE ? ESCAPE '\\'`
}

function dimensionParam(condition: EnergyFilterCondition): string {
  if (condition.match === 'exact') {
    return condition.value.toLowerCase()
  }
  // %, _ and \ are LIKE wildcards; escape them so the value matches literally
  const escaped = condition.value.toLowerCase().replace(/[\\%_]/g, char => `\\${char}`)
  return `%${escaped}%`
}

/** The filter as conditions on `energy_samples` rows. */
function samplesFilter(filter: EnergyFilter): FilterSql {
  const active = activeConditions(filter)
  return {
    condition: active.map(dimensionClause).join(' AND '),
    params: active.map(dimensionParam),
  }
}

/**
 * The filter as conditions on `energy_events` rows: conditions whose
 * dimension the table carries apply directly; the rest keep the logs
 * whose samples match.
 */
function eventsFilter(filter: EnergyFilter, eventColumns: ReadonlySet<string>): FilterSql {
  const direct = activeConditions(filter).filter(condition => eventColumns.has(condition.dimension))
  const viaSamples = activeConditions(filter).filter(condition => !eventColumns.has(condition.dimension))

  const conditions: string[] = []
  const params: string[] = []
  if (direct.length > 0) {
    conditions.push(direct.map(dimensionClause).join(' AND '))
    params.push(...direct.map(dimensionParam))
  }
  if (viaSamples.length > 0) {
    conditions.push(
      `energy_log_id IN (SELECT energy_log_id FROM energy_samples WHERE ${viaSamples
        .map(dimensionClause)
        .join(' AND ')})`,
    )
    params.push(...viaSamples.map(dimensionParam))
  }

  return { condition: conditions.join(' AND '), params }
}

/** The present conditions as a WHERE clause, empty when there are none. */
function whereSql(conditions: readonly string[]): string {
  const present = conditions.filter(condition => condition !== '')
  return present.length === 0 ? '' : ` WHERE ${present.join(' AND ')}`
}

/**
 * The filterable dimensions of the loaded records: the string columns
 * of `energy_samples` that describe the sample or its log. Must only
 * be called after `loadEnergyFiles` filled the tables.
 */
export async function listFilterDimensions(): Promise<readonly FilterDimension[]> {
  const described = await queryEnergy('DESCRIBE energy_samples;')
  const names = described
    .filter(
      row =>
        String(row['column_type']).toUpperCase() === 'VARCHAR' &&
        DIMENSION_NAME_PATTERN.test(String(row['column_name'])) &&
        !NON_DIMENSION_COLUMNS.has(String(row['column_name'])),
    )
    .map(row => String(row['column_name']))

  return Promise.all(
    names.map(async name => {
      const rows = await queryEnergy(`
        SELECT DISTINCT ${name} AS value
        FROM energy_samples
        WHERE ${name} IS NOT NULL
        ORDER BY value
        LIMIT ${LIMITED_VALUE_COUNT + 1}
      `)
      const values = rows.map(row => toStringValue(row['value']))
      return { name, values: values.length <= LIMITED_VALUE_COUNT ? values : null }
    }),
  )
}

/**
 * The sessions of the loaded records, earliest first — only sessions
 * with records matching the filter. Must only be called after
 * `loadEnergyFiles` filled the tables.
 */
export async function listSessions(filter: EnergyFilter = []): Promise<readonly SessionSummary[]> {
  const describedEvents = await queryEnergy('DESCRIBE energy_events;')
  const eventColumns = new Set(describedEvents.map(row => String(row['column_name'])))
  const { condition, params } = eventsFilter(filter, eventColumns)

  const rows = await queryEnergy(`
    SELECT
      session_id AS session_id,
      CAST(COUNT(*) AS INT) AS requests,
      CAST(MIN(time) AS VARCHAR) AS first_time
    FROM energy_events
    ${whereSql(['session_id IS NOT NULL', condition])}
    GROUP BY session_id
    ORDER BY first_time
  `, params)

  return rows.map(row => ({
    sessionId: toStringValue(row['session_id']),
    requests: toNumber(row['requests']),
    firstTime: toStringOrNull(row['first_time']),
  }))
}

/**
 * Collapses the chronological request rows into chronology entries: a
 * run of consecutive requests within one session with the same agent,
 * kind and prompt is one agent loop working through one prompt, and
 * becomes one entry carrying the run's totals. A new prompt, a
 * compaction, a different agent or a new session breaks the run and
 * starts a new entry.
 *
 * Note: this expects rows to be sorted by session ID and time.
 */
function collapsePromptRuns<Row extends PromptRunRow>(rows: readonly Row[]): PromptRun<Row>[] {
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

/**
 * Every prompt of the session as one chronology entry each, in
 * chronological order: consecutive requests with the same prompt —
 * the queries one agent loop made for it — are collapsed into a
 * single entry with the run's energy totals.
 */
export async function listSessionPrompts(
  sessionId: string,
  filter: EnergyFilter = [],
): Promise<readonly SessionPrompt[]> {
  // the energy and carbon columns live on the flattened samples, and
  // vary with the format the logger wrote
  const described = await queryEnergy('DESCRIBE energy_samples;')
  const columns = new Set(described.map(row => String(row['column_name'])))
  const energy = energyExpression(columns)
  const carbon = columns.has('carbon_g_co2eq') ? numericExpression('carbon_g_co2eq') : null

  const describedEvents = await queryEnergy('DESCRIBE energy_events;')
  const eventColumns = new Set(describedEvents.map(row => String(row['column_name'])))
  const { condition, params } = eventsFilter(filter, eventColumns)

  const rows = await queryEnergy(
    `
    SELECT
      e.session_id AS session_id,
      e.energy_log_id AS id,
      CAST(e.time AS VARCHAR) AS time,
      e.kind AS kind,
      e.model AS model,
      e.agent AS agent,
      e.prompt AS prompt,
      COALESCE(s.kwh, 0) AS kwh,
      s.carbon_g AS carbon_g,
      CAST(COALESCE(s.samples, 0) AS INT) AS samples
    FROM energy_events e
    LEFT JOIN (
      SELECT
        energy_log_id AS id,
        ${energy === null ? 'NULL' : `COALESCE(SUM(${energy}), 0)`} AS kwh,
        ${sumAs(carbon, 'carbon_g')},
        CAST(COUNT(*) AS INT) AS samples
      FROM energy_samples
      GROUP BY energy_log_id
    ) s ON s.id = e.energy_log_id
    WHERE e.session_id = ?${condition !== '' ? ` AND ${condition}` : ''}
    ORDER BY e.time, e.energy_log_id
  `,
    [sessionId, ...params],
  )

  return collapsePromptRuns(
    rows.map(row => ({
      sessionId: toStringValue(row['session_id']),
      id: toStringOrNull(row['id']),
      time: toStringOrNull(row['time']),
      kind: toStringOrNull(row['kind']),
      model: toStringOrNull(row['model']),
      agent: toStringOrNull(row['agent']),
      prompt: toStringOrNull(row['prompt']),
      kwh: toNumber(row['kwh']),
      carbonG: toNumberOrNull(row['carbon_g']),
      samples: toNumber(row['samples']),
    })),
  )
}

/**
 * One request of the loaded records as the top-prompts query returns
 * it, before grouping.
 */
interface TopPromptRow {
  readonly sessionId: string
  readonly id: string | null
  readonly kind: string | null
  readonly agent: string | null
  readonly prompt: string | null
  readonly kwh: number
}

/**
 * Returns the most expensive prompts of the loaded records. Must only
 * be called after `loadEnergyFiles` filled the tables.
 */
export async function listTopPrompts(
  filter: EnergyFilter = [],
  limit = 10,
): Promise<readonly TopPrompt[]> {
  const described = await queryEnergy('DESCRIBE energy_samples;')
  const columns = new Set(described.map(row => String(row['column_name'])))
  const energy = energyExpression(columns)
  if (energy === null) {
    throw new Error('The loaded energy records contain no energy measurements')
  }

  const describedEvents = await queryEnergy('DESCRIBE energy_events;')
  const eventColumns = new Set(describedEvents.map(row => String(row['column_name'])))
  const { condition, params } = eventsFilter(filter, eventColumns)

  const rows = await queryEnergy(
    `
    SELECT
      e.session_id AS session_id,
      e.energy_log_id AS id,
      e.kind AS kind,
      e.agent AS agent,
      e.prompt AS prompt,
      COALESCE(s.kwh, 0) AS kwh
    FROM energy_events e
    LEFT JOIN (
      SELECT energy_log_id AS id, COALESCE(SUM(${energy}), 0) AS kwh
      FROM energy_samples
      GROUP BY energy_log_id
    ) s ON s.id = e.energy_log_id
    ${whereSql(['e.session_id IS NOT NULL', 'e.prompt IS NOT NULL', condition])}
    ORDER BY e.session_id, e.time, e.energy_log_id
  `,
    params,
  )

  return topPromptsOf(
    rows.map(row => ({
      sessionId: toStringValue(row['session_id']),
      id: toStringOrNull(row['id']),
      kind: toStringOrNull(row['kind']),
      agent: toStringOrNull(row['agent']),
      prompt: toStringOrNull(row['prompt']),
      kwh: toNumber(row['kwh']),
    })),
    limit,
  )
}

/**
 * Collapses the rows into chronology entries — runs of consecutive
 * rows within one session sharing a prompt, kind and agent — and
 * returns the most expensive ones.
 */
function topPromptsOf(rows: readonly TopPromptRow[], limit: number): TopPrompt[] {
  return collapsePromptRuns(rows)
    .sort((a, b) => b.kwh - a.kwh)
    .slice(0, limit)
    .map(run => ({
      prompt: run.prompt ?? '',
      kind: run.kind,
      agent: run.agent,
      kwh: run.kwh,
      location: run.ids.length > 0 ? { sessionId: run.sessionId, logId: run.ids[0] } : null,
    }))
}

export async function getEnergyRecords(
  ids: readonly string[],
): Promise<readonly Record<string, unknown>[]> {
  if (ids.length === 0) {
    return []
  }

  const placeholders = ids.map(() => '?').join(', ')
  const [eventRows, sampleRows] = await Promise.all([
    queryEnergy(`SELECT * FROM energy_events WHERE energy_log_id IN (${placeholders})`, [...ids]),
    queryEnergy(`SELECT * FROM energy_samples WHERE energy_log_id IN (${placeholders})`, [...ids]),
  ])

  const eventsById = new Map<string, Record<string, unknown>>()
  for (const event of eventRows) {
    eventsById.set(String(event['energy_log_id']), event)
  }

  const samplesById = new Map<string, Array<Record<string, unknown>>>()
  for (const row of sampleRows) {
    const id = String(row['energy_log_id'])
    const existing = samplesById.get(id)
    if (existing === undefined) {
      samplesById.set(id, [row])
    } else {
      existing.push(row)
    }
  }

  const records: Record<string, unknown>[] = []
  for (const id of ids) {
    const event = eventsById.get(id)
    if (event === undefined) {
      continue
    }

    const parentKeys = new Set(Object.keys(event))
    const record: Record<string, unknown> = { ...event }
    delete record.energy_samples

    // a sample row repeats its parent record's fields; only the fields
    // the sample itself carries belong in the reassembled array, so
    // we ignore any column in the sample, that is also in the parent
    const samples = (samplesById.get(id) ?? []).map(row => {
      const sample: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) {
        if (!parentKeys.has(key)) {
          sample[key] = value
        }
      }
      return sample
    })
    if (samples.length > 0) {
      record.energy = samples
    }

    records.push(record)
  }

  return records
}
