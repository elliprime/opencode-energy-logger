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

/** Energy grouped by a record field, both must exist as columns. */
async function groupBy(column: string, energy: string, carbon: string | null): Promise<GroupEnergy[]> {
  const rows = await queryEnergy(`
    SELECT
      ${column} AS label,
      COALESCE(SUM(${energy}), 0) AS kwh,
      ${sumAs(carbon, 'carbon_g')},
      CAST(COUNT(*) AS INT) AS samples
    FROM energy_samples
    WHERE ${column} IS NOT NULL
    GROUP BY ${column}
    ORDER BY kwh DESC
  `)

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
export async function computeDashboardStats(): Promise<DashboardStats> {
  const described = await queryEnergy('DESCRIBE energy_samples;')
  const columns = new Set(described.map(row => String(row['column_name'])))

  const energy = energyExpression(columns)
  if (energy === null) {
    throw new Error('The loaded energy records contain no energy measurements')
  }
  const carbon = columns.has('carbon_g_co2eq') ? 'carbon_g_co2eq' : null
  const duration = columns.has('duration_seconds') ? 'duration_seconds' : null

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
    `),
    queryEnergy(`
      SELECT
        CAST(COUNT(*) AS INT) AS requests,
        CAST(COUNT(DISTINCT session_id) AS INT) AS sessions
      FROM energy_events
    `),
    groupBy('model', energy, carbon),
    groupBy('agent', energy, carbon),
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
