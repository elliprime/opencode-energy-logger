'use client'

import { useEffect, useRef, useState } from 'react'
import type { HTMLPerspectiveViewerElement, ViewerConfigUpdate } from '@perspective-dev/viewer'
import { ENERGY_TABLES, getEnergyClient, type LoadedEnergyColumns } from '@/lib/energy/perspective'
import { enhancePromptColumn } from '@/lib/energy/prompt-column'

type TableId = keyof typeof ENERGY_TABLES

const TABLE_TABS: readonly { id: TableId; label: string }[] = [
  { id: 'samples', label: 'Energy samples' },
  { id: 'events', label: 'Events' },
  { id: 'annotations', label: 'Annotations' },
]

/**
 * The initial report for each table: flat, one row per record or
 * sample.
 */
const DEFAULT_CONFIGS: Record<TableId, ViewerConfigUpdate> = {
  samples: {
    table: ENERGY_TABLES.samples,
    columns: [
      'session_id',
      'time',
      'energy_kwh',
      'carbon_g_co2eq',
      'duration_seconds',
      'prompt',
      'annotations',
    ],
    aggregates: { energy_kwh: 'sum', carbon_g_co2eq: 'sum', duration_seconds: 'sum' },
    sort: [['energy_kwh', 'desc']],
    columns_config: {
      // LLM responses take far less than a single kWh, so we need to allow more decimal places
      energy_kwh: { number_format: { maximumSignificantDigits: 5 } },
      // prompts are long; without a width the auto-sized column would
      // stretch the table to the length of the text. the cells are
      // ellipsized and expandable (see the prompt-column module).
      prompt: { column_size_override: 600 },
    },
  },
  events: {
    table: ENERGY_TABLES.events,
    columns: ['session_id', 'time', 'kind', 'model', 'annotations', 'energy_samples'],
    aggregates: { energy_samples: 'sum' },
    sort: [['time', 'desc']],
    columns_config: {
      prompt: { column_size_override: 600 },
    },
  },
  annotations: {
    table: ENERGY_TABLES.annotations,
    columns: ['session_id', 'energy_log_id', 'tag'],
    sort: [['session_id', 'asc']],
  },
}

/**
 * The default report of a table, reduced to the columns the loaded data
 * actually has: a record set that lacks a field the default references
 * (e.g. samples without the provider's `energy_kwh`) would otherwise fail
 * the restore with an unknown-column error instead of showing the data.
 */
function defaultConfigFor(table: TableId, available: string[]): ViewerConfigUpdate {
  const config = DEFAULT_CONFIGS[table]
  const present = (column: string) => available.includes(column)

  return {
    ...config,
    columns: (config.columns ?? []).filter(column => column !== null && present(column)),
    aggregates: presentEntries(config.aggregates ?? {}, present),
    sort: (config.sort ?? []).filter(([column]) => present(column)),
    columns_config: presentEntries(config.columns_config ?? {}, present),
  }
}

function presentEntries<T>(values: Record<string, T>, present: (column: string) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([column]) => present(column)))
}

/**
 * The themes Perspective ships with (their css is imported by the
 * energy lib); the `theme` attribute of <perspective-viewer> picks one.
 */
const THEMES = [
  'Pro Light',
  'Pro Dark',
  'Gruvbox Light',
  'Gruvbox Dark',
  'Solarized',
  'Solarized Dark',
  'Nord',
  'Blueprint',
  'Ledger',
  'Monokai',
  'Dracula',
  'Vaporwave',
  'Botanical',
  'Eggplant',
  'Phosphor',
  'Velvet',
] as const

const DEFAULT_THEME = 'Pro Light'
const THEME_STORAGE_KEY = 'energy-report.theme'

function initialTheme(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_THEME
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return stored !== null && (THEMES as readonly string[]).includes(stored) ? stored : DEFAULT_THEME
}

interface RawDataReportProps {
  /** The columns of the loaded tables (see `loadEnergyFiles`). */
  columns: LoadedEnergyColumns
}

export function RawDataReport({ columns }: RawDataReportProps) {
  const viewer = useRef<HTMLPerspectiveViewerElement | null>(null)
  const [table, setTable] = useState<TableId>('samples')
  const [clientReady, setClientReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState(initialTheme)

  // true once the viewer has a panel to restore into
  const [reportReady, setReportReady] = useState(false)

  // the prompt column is ellipsized and click-expandable — the helper
  // adds styles and wires the datagrid plugin elements as they appear.
  useEffect(() => {
    const element = viewer.current
    if (element === null) {
      return
    }
    return enhancePromptColumn(element)
  }, [])

  // bind the DuckDB-backed virtual server client to the viewer
  // element. the data itself is already loaded by the parent.
  useEffect(() => {
    let cancelled = false

    getEnergyClient()
      .then(async client => {
        if (cancelled || viewer.current === null) {
          return
        }

        await viewer.current.load(client)
        if (!cancelled) {
          setClientReady(true)
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
  }, [])

  // apply the default report of the active table once the client is
  // bound, and again whenever the user switches tables.
  useEffect(() => {
    const element = viewer.current
    if (!clientReady || element === null) {
      return
    }

    let cancelled = false
    element
      .restore(defaultConfigFor(table, columns[table]))
      .then(() => {
        if (!cancelled) {
          setReportReady(true)
        }
      })
      .catch(caught => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })

    return () => {
      cancelled = true
    }
  }, [table, clientReady, columns])

  // apply the theme: the attribute restyles the viewer's css, and the
  // partial restore() additionally repaints canvas plugins. neither
  // touches the report the user has configured — but the restore needs
  // a panel to update, so it waits for the first report.
  useEffect(() => {
    const element = viewer.current
    if (element === null) {
      return
    }

    element.setAttribute('theme', theme)
    if (!reportReady) {
      return
    }

    element.restore({ theme }).catch(caught => {
      setError(caught instanceof Error ? caught.message : String(caught))
    })
  }, [theme, reportReady])

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-zinc-500">
        Group, filter and chart the records in the side panel — Perspective translates the report
        you configure into DuckDB queries.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {TABLE_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setTable(tab.id)}
              disabled={!clientReady}
              aria-pressed={table === tab.id}
              className={
                table === tab.id
                  ? 'rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white'
                  : 'rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50'
              }
            >
              {tab.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-500">
          Theme
          <select
            value={theme}
            onChange={event => {
              setTheme(event.target.value)
              window.localStorage.setItem(THEME_STORAGE_KEY, event.target.value)
            }}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none"
          >
            {THEMES.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error !== null ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-base text-red-800">
          {error}
        </p>
      ) : null}
      <div className="h-[36rem] overflow-hidden rounded-md border border-zinc-200">
        <perspective-viewer ref={viewer} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  )
}
