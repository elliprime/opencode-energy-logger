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
 * One chronology entry: a run of consecutive requests with the same
 * agent, kind and prompt — the queries one agent loop made to fulfill
 * that prompt — collapsed into a single entry. The scalar fields
 * describe the first request of the run, the energy fields total the
 * whole run, and `ids` lists every collapsed log in order.
 */
export interface SessionPrompt {
  readonly time: string | null
  readonly kind: string | null
  readonly model: string | null
  readonly agent: string | null
  readonly prompt: string | null
  readonly kwh: number
  readonly carbonG: number | null
  readonly samples: number
  /** How many logs the entry collapses; 1 when nothing collapsed. */
  readonly logs: number
  readonly ids: readonly string[]
}

/**
 * The expression summing to kWh per sample, or null if the records
 * carry neither of the two known energy fields.
 */
function energyExpression(columns: Set<string>): string | null {
  if (columns.has('energy_kwh')) {
    return 'energy_kwh'
  }
  if (columns.has('energy_joules')) {
    return 'energy_joules / 3600000.0'
  }
  return null
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
  const carbon = columns.has('carbon_g_co2eq') ? 'carbon_g_co2eq' : null
  const duration = columns.has('duration_seconds') ? 'duration_seconds' : null

  const describedEvents = await queryEnergy('DESCRIBE energy_events;')
  const eventColumns = new Set(describedEvents.map(row => String(row['column_name'])))
  const samples = samplesFilter(filter)
  const events = eventsFilter(filter, eventColumns)

  const [totalRows, countRows, byModel, byAgent] = await Promise.all([
    queryEnergy(`
      SELECT
        CAST(COUNT(*) AS INT) AS samples,
        COALESCE(SUM(${energy}), 0) AS total_kwh,
        ${sumAs(carbon, 'total_carbon_g')},
        ${sumAs(duration, 'total_duration_seconds')},
        CAST(MIN(strftime(time, '%Y-%m-%d')) AS VARCHAR) AS first_day,
        CAST(MAX(strftime(time, '%Y-%m-%d')) AS VARCHAR) AS last_day
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
 * run of consecutive requests with the same agent, kind and prompt is
 * one agent loop working through one prompt, and becomes one entry
 * carrying the run's totals. A new prompt, a compaction or a different
 * agent breaks the run and starts a new entry.
 */
function collapsePromptRuns(rows: readonly PromptRow[]): SessionPrompt[] {
  const entries: SessionPrompt[] = []

  for (const row of rows) {
    const previous = entries[entries.length - 1]
    if (
      previous !== undefined &&
      previous.agent === row.agent &&
      previous.kind === row.kind &&
      previous.prompt === row.prompt
    ) {
      entries[entries.length - 1] = {
        ...previous,
        kwh: previous.kwh + row.kwh,
        carbonG:
          previous.carbonG === null && row.carbonG === null
            ? null
            : (previous.carbonG ?? 0) + (row.carbonG ?? 0),
        samples: previous.samples + row.samples,
        logs: previous.logs + 1,
        ids: row.id !== null ? [...previous.ids, row.id] : previous.ids,
      }
    } else {
      entries.push({
        time: row.time,
        kind: row.kind,
        model: row.model,
        agent: row.agent,
        prompt: row.prompt,
        kwh: row.kwh,
        carbonG: row.carbonG,
        samples: row.samples,
        logs: 1,
        ids: row.id !== null ? [row.id] : [],
      })
    }
  }

  return entries
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
  const carbon = columns.has('carbon_g_co2eq') ? 'carbon_g_co2eq' : null

  const describedEvents = await queryEnergy('DESCRIBE energy_events;')
  const eventColumns = new Set(describedEvents.map(row => String(row['column_name'])))
  const { condition, params } = eventsFilter(filter, eventColumns)

  const rows = await queryEnergy(
    `
    SELECT
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
