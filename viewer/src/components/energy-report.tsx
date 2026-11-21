'use client'

import { useEffect, useState } from 'react'
import {
  loadEnergyFiles,
  syncPromptAnnotations,
  type LoadedEnergyColumns,
} from '@/lib/energy/perspective'
import {
  listFilterDimensions,
  isAnnotationCondition,
  ANNOTATION_DIMENSION,
  type EnergyFilter,
  type FilterDimension,
} from '@/lib/energy/stats'
import { AnnotationsProvider, useReportAnnotations } from './annotations-provider'
import { EnergyDashboard } from './energy-dashboard'
import { EnergyFilterBar } from './energy-filter'
import { RawDataReport } from './raw-data-report'

type ReportTab = 'dashboard' | 'raw-data'

const REPORT_TABS: readonly { id: ReportTab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'raw-data', label: 'Raw Data' },
]

interface EnergyReportProps {
  /** The energy files to analyze together, e.g. `ses_1e2f3g4h5i6j7k8l.jsonl`. */
  filenames: string[]
  /** Where the energy directory came from, e.g. a path, URL or archive name. */
  source: string
}

/**
 * Remounted per analysis (the parent passes a `key`), so loading
 * state starts fresh for every analyzed energy directory.
 */
export function EnergyReport({ filenames, source }: EnergyReportProps) {
  return (
    <AnnotationsProvider source={source}>
      <EnergyReportBody filenames={filenames} source={source} />
    </AnnotationsProvider>
  )
}

function EnergyReportBody({ filenames, source }: EnergyReportProps) {
  const [tab, setTab] = useState<ReportTab>('dashboard')
  const [rawDataVisited, setRawDataVisited] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [columns, setColumns] = useState<LoadedEnergyColumns | null>(null)
  const [dimensions, setDimensions] = useState<readonly FilterDimension[] | null>(null)
  const [filter, setFilter] = useState<EnergyFilter>([])
  const [annotationsSyncCount, setAnnotationsSyncCount] = useState(0)
  const { annotations, knownTags } = useReportAnnotations()

  // load all energy files into DuckDB, shared by both tabs
  useEffect(() => {
    let cancelled = false

    loadEnergyFiles(filenames)
      .then(loaded => {
        if (!cancelled) {
          setColumns(loaded)
        }
      })
      .catch(caught => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Something went wrong')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [filenames])

  // the filterable dimensions of the loaded records, for the filter bar
  useEffect(() => {
    if (columns === null) {
      return
    }

    let cancelled = false
    listFilterDimensions()
      .then(result => {
        if (!cancelled) {
          setDimensions(result)
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
  }, [columns])

  // mirror the annotations into DuckDB once the tables exist, and
  // again whenever an annotation changes — the filter conditions and
  // the raw data view query the DuckDB data
  useEffect(() => {
    if (columns === null) {
      return
    }

    let cancelled = false
    syncPromptAnnotations([...annotations.values()])
      .then(() => {
        if (!cancelled) {
          setAnnotationsSyncCount(version => version + 1)
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
  }, [columns, annotations])

  function selectTab(id: ReportTab) {
    setTab(id)
    if (id === 'raw-data') {
      setRawDataVisited(true)
    }
  }

  // when a sync occurs, this value ends up incremented, which is used to trigger a re-compute in dashboard stats
  const annotationsSyncCountResolved = filter.some(isAnnotationCondition) ? annotationsSyncCount : 0

  // the annotation dimension filters through the `prompt_annotations`
  // table, which exists only once the first mirror sync completed
  const filterDimensions =
    dimensions === null
      ? null
      : annotationsSyncCount > 0
        ? [...dimensions, { name: ANNOTATION_DIMENSION, values: knownTags }]
        : dimensions

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-xs relative">
      <div className="flex items-baseline justify-between gap-4 absolute" style={{top: '20px', right: '20px'}}>
        {busy ? (
          <span className="text-sm text-zinc-500">
            Loading {filenames.length} {filenames.length === 1 ? 'file' : 'files'}…
          </span>
        ) : (
          <div
            className="truncate font-mono text-sm text-zinc-500 text-right grow"
            title={`${filenames.length} ${filenames.length === 1 ? 'file' : 'files'} from ${source}`}
          >
            {filenames.length} {filenames.length === 1 ? 'file' : 'files'} · {source}
          </div>
        )}
      </div>
      <div role="tablist" aria-label="Report views" className="flex gap-2">
        {REPORT_TABS.map(reportTab => (
          <button
            key={reportTab.id}
            type="button"
            role="tab"
            aria-selected={tab === reportTab.id}
            onClick={() => selectTab(reportTab.id)}
            disabled={busy}
            className={
              tab === reportTab.id
                ? 'rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white'
                : 'rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50'
            }
          >
            {reportTab.label}
          </button>
        ))}
      </div>
      {tab === 'dashboard' && filterDimensions !== null ? (
        <EnergyFilterBar dimensions={filterDimensions} filter={filter} onChange={setFilter} />
      ) : null}
      {error !== null ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-base text-red-800">
          {error}
        </p>
      ) : null}
      {columns !== null ? (
        <>
          <div role="tabpanel" hidden={tab !== 'dashboard'}>
            <EnergyDashboard filter={filter} annotationSyncCount={annotationsSyncCountResolved} />
          </div>
          {rawDataVisited ? (
            <div role="tabpanel" hidden={tab !== 'raw-data'}>
              <RawDataReport columns={columns} />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
