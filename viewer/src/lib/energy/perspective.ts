/**
 * Browser-side energy report powered by Perspective over DuckDB-WASM.
 *
 * All energy files of the analyzed directory are parsed and loaded
 * together into DuckDB as two tables:
 *
 * - `energy_events`: one row per energy record of all files combined
 *   (deduplicated by record id, keeping the newest by time), tagged
 *   with the `session_id` derived from the file name the record was
 *   read from.
 * - `energy_samples`: the `energy` array of every record flattened
 *   into one row per measured energy sample, joined with the fields of
 *   its parent record. Both tables share the `energy_log_id` column —
 *   the id of the energy log a row belongs to; there is no per-sample
 *   id.
 *
 *   Both record tables also carry `run_first_log_id`, the first log id
 *   of the prompt run a row belongs to (see `runFirstLogIds`), through
 *   which annotations resolve the run they belong to.
 *
 *   Note: the energy_samples table is denormalized primarily because
 *   perspective.js does not support JOINs.
 *
 * - `prompt_annotations`: the user's prompt-run annotations, mirrored
 *   from localStorage by `syncPromptAnnotations` — one row per log id
 *   and tag. The record tables carry the same tags joined in their
 *   `annotations` column.
 *
 * Perspective's DuckDB virtual server then translates whatever report
 * the user configures in the `<perspective-viewer>` UI into DuckDB
 * queries — no report or query is hardcoded in this app.
 *
 * The records are inserted through Apache Arrow instead of DuckDB's
 * `read_json_auto`, because the JSON reader is a loadable extension in
 * DuckDB-WASM and would be downloaded from extensions.duckdb.org at
 * runtime.
 *
 * This module must only be imported from client components: it
 * registers web components, spawns web workers and fetches wasm
 * binaries from /public.
 */

import * as arrow from 'apache-arrow'
import * as duckdb from '@duckdb/duckdb-wasm'
import { createMessageHandler, init_server, worker } from '@perspective-dev/client'
import { DuckDBHandler } from '@perspective-dev/client/virtual_servers/duckdb'

// imports with side-effect: register the datagrid and chart plugins of the
// <perspective-viewer> element.
import '@perspective-dev/viewer-datagrid'
import '@perspective-dev/viewer-charts'
import '@perspective-dev/viewer/themes'

// perspective's virtual servers do not implement tree collapse: clicking
// a grouped row in the datagrid sends a ViewCollapseReq that the wasm
// dispatcher answers with an "Unhandled request" console error — and
// nothing else, the click is just a no-op (there is no feature flag the
// datagrid would respect either). silence exactly that known-benign
// message so it does not pollute the console; everything else still
// gets through.
const consoleError = console.error.bind(console)
console.error = (...args: unknown[]) => {
  if (
    args.length === 1 &&
    typeof args[0] === 'string' &&
    /^_client::virtual_server::server:\d+ Unhandled request: ViewCollapseReq/.test(args[0])
  ) {
    return
  }
  consoleError(...args)
}

import type { PromptRunAnnotation } from './annotations'
import { findRunFirstLogIds } from './prompt-runs'

/**
 * A Perspective client over the DuckDB virtual server.
 */
export type EnergyClient = Awaited<ReturnType<typeof worker>>

/**
 * The table ids of the tables hosted in DuckDB, as hosted by the
 * virtual server (`memory.` database prefix).
 */
export const ENERGY_TABLES = {
  samples: 'memory.energy_samples',
  events: 'memory.energy_events',
  annotations: 'memory.prompt_annotations',
} as const

/** The columns of the `prompt_annotations` table (see `syncPromptAnnotations`). */
export const PROMPT_ANNOTATION_COLUMNS = ['session_id', 'energy_log_id', 'tag'] as const

/** Energy file names are safe to use in URLs after this check. */
const FILENAME_PATTERN = /^[\w.-]+$/

const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: '/duckdb/duckdb-mvp.wasm',
    mainWorker: '/duckdb/duckdb-browser-mvp.worker.js',
  },
  eh: {
    mainModule: '/duckdb/duckdb-eh.wasm',
    mainWorker: '/duckdb/duckdb-browser-eh.worker.js',
  },
}

/** One record of an energy JSONL file, with its measured samples. */
interface EnergyRecord {
  readonly time?: unknown
  id?: unknown
  readonly energy?: unknown
  sessionID?: unknown
  [key: string]: unknown
}

/** Record fields in a stable, readable column order. */
const RECORD_FIELDS = [
  'time',
  'session_id',
  'kind',
  'agent',
  'model',
  'branch',
  'url',
  'prompt',
  'energy_log_id',
  'type',
]

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

let duckdbPromise: Promise<duckdb.AsyncDuckDB> | null = null
let connectionPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null
let viewerModulePromise: Promise<typeof import('@perspective-dev/viewer')> | null = null
let bootstrapPromise: Promise<void> | null = null

/**
 * the `<perspective-viewer>` module, loaded from the self-contained
 * build in public/perspective/. it cannot be bundled: its init_client()
 * imports the wasm glue from a runtime blob URL, which bundlers cannot
 * resolve, so turbopackIgnore keeps this a native runtime import.
 */
function getViewerModule(): Promise<typeof import('@perspective-dev/viewer')> {
  if (viewerModulePromise === null) {
    const url = new URL('/perspective/perspective-viewer.js', window.location.origin)
    viewerModulePromise = import(/* turbopackIgnore: true */ url.href)
  }
  return viewerModulePromise
}

function getDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (duckdbPromise === null) {
    duckdbPromise = (async () => {
      const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES)
      if (bundle.mainWorker === null) {
        throw new Error('DuckDB found no wasm bundle this browser supports')
      }

      const webWorker = new Worker(bundle.mainWorker)
      const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), webWorker)
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
      return db
    })()
  }

  return duckdbPromise
}

function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  if (connectionPromise === null) {
    connectionPromise = (async () => {
      const conn = await (await getDuckDB()).connect()

      // required to match Perspective's sort-null semantics
      await conn.query('SET default_null_order=NULLS_FIRST_ON_ASC_LAST_ON_DESC;')
      return conn
    })()
  }

  return connectionPromise
}

/**
 * Bootstraps Perspective's own wasm binaries once. `init_server` powers
 * the client, `init_client` the `<perspective-viewer>` element (and,
 * through it, the DuckDB virtual server handler).
 */
function bootstrapPerspective(): Promise<void> {
  if (bootstrapPromise === null) {
    bootstrapPromise = (async () => {
      const viewerModule = await getViewerModule()
      await Promise.all([
        init_server(fetch('/perspective/perspective-server.wasm')),
        viewerModule.init_client(fetch('/perspective/perspective-viewer.wasm')),
      ])
    })()
  }
  return bootstrapPromise
}

/** Parses the JSONL of an energy file, skipping malformed lines. */
function parseJsonl(text: string): EnergyRecord[] {
  const records: EnergyRecord[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }
    try {
      const value: unknown = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        records.push(value as EnergyRecord)
      }
    } catch {
      // skip malformed lines, e.g. a line that is currently being
      // written to
    }
  }
  return records
}

/**
 * Sets the session_id property to the session ID parsed from the file name. (sessionID is stored in
 * the data but is not trusted here.)
 */
function withSessionId(record: EnergyRecord, sessionId: string): EnergyRecord {
  const copy: EnergyRecord = { ...record }
  delete copy.sessionID
  copy.session_id = sessionId
  return copy
}

/**
 * Renames the record's `id` field to `energy_log_id`.
 */
function withEnergyLogId(record: EnergyRecord): EnergyRecord {
  const copy: EnergyRecord = { ...record }
  copy.energy_log_id = copy.id
  delete copy.id
  return copy
}

/**
 * The records deduplicated by id, keeping the newest by time. Records
 * without an id are kept as-is.
 */
function dedupeRecords(records: EnergyRecord[]): EnergyRecord[] {
  const byId = new Map<string, EnergyRecord>()
  records.forEach((record, index) => {
    const key = typeof record.id === 'string' && record.id.length > 0 ? record.id : `\0${index}`
    const previous = byId.get(key)
    if (previous === undefined || timeOf(record) > timeOf(previous)) {
      byId.set(key, record)
    }
  })
  return [...byId.values()]
}

function timeOf(record: EnergyRecord): string {
  return typeof record.time === 'string' ? record.time : ''
}

/**
 * A value as a column entry Apache Arrow can infer a type from: ISO
 * timestamps become Date instances, nested objects and arrays plain
 * JSON strings.
 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string' && TIMESTAMP_PATTERN.test(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value)
  }
  return value
}

/**
 * Column-oriented data for Arrow, with the record fields in a stable
 * order followed by any unknown fields the logger added.
 */
function columnsOf(rows: Array<Record<string, unknown>>): Record<string, unknown[]> {
  const keys = new Set<string>(RECORD_FIELDS)
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      keys.add(key)
    }
  }

  const columns: Record<string, unknown[]> = {}
  for (const key of keys) {
    // a missing field must become null: undefined would crash Arrow's type
    // inference ("Cannot convert undefined to a BigInt" in a Date column)
    columns[key] = rows.map(row => normalizeValue(row[key] ?? null))
  }
  return columns
}

/** Inserts rows as a DuckDB table through Apache Arrow. */
async function insertTable(
  conn: duckdb.AsyncDuckDBConnection,
  name: string,
  columns: Record<string, unknown[]>,
): Promise<void> {
  const table = tableFromColumns(columns)
  await conn.query(`DROP TABLE IF EXISTS ${name};`)
  await conn.insertArrowFromIPCStream(arrow.tableToIPC(table, 'stream'), { name, create: true })
}

function tableFromColumns(columns: Record<string, unknown[]>): arrow.Table {
  const fields: arrow.Field[] = []
  const vectors: Record<string, arrow.Vector> = {}
  for (const [name, values] of Object.entries(columns)) {
    const { field, vector } = typedColumn(name, values)
    fields.push(field)
    vectors[name] = vector
  }
  return new arrow.Table(new arrow.Schema(fields), vectors)
}

/**
 * A column as a nullable Arrow field and vector.
 */
function typedColumn(name: string, values: unknown[]): { field: arrow.Field, vector: arrow.Vector } {
  const present = values.filter(value => value !== null && value !== undefined)

  if (present.length === 0) {
    // no values to agree on a type: strings, like any column of undecided
    // type
    return arrowColumn(name, new arrow.Utf8(), values.map(asString))
  }

  if (present.every(value => value instanceof Date)) {
    return arrowColumn(name, new arrow.Timestamp(arrow.TimeUnit.MILLISECOND), values)
  }
  
  if (present.every(value => typeof value === 'number')) {
    return arrowColumn(name, new arrow.Float64(), values)
  }
  
  if (present.every(value => typeof value === 'boolean')) {
    return arrowColumn(name, new arrow.Bool(), values)
  }
  
  return arrowColumn(name, new arrow.Utf8(), values.map(asString))
}

/** A column's nullable Arrow field and vector of the given type. */
function arrowColumn(name: string, type: arrow.DataType, values: unknown[]): { field: arrow.Field, vector: arrow.Vector } {
  return {
    field: new arrow.Field(name, type, true),
    vector: arrow.vectorFromArray(values, type),
  }
}

/** The string a value degrades to in a string column. */
function asString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Makes sure table loads only happen one at a time: concurrent invocations
 * (e.g. React Strict Mode running effects twice during development) must not
 * interleave their DROP TABLE and CREATE TABLE statements.
 */
let loadChain: Promise<unknown> = Promise.resolve()

/** The column names of the tables in DuckDB. */
export interface LoadedEnergyColumns {
  readonly events: string[]
  readonly samples: string[]
  readonly annotations: string[]
}

/**
 * Fetches the JSONL of the given energy files and loads them together
 * into DuckDB as the `energy_events` and `energy_samples` tables —
 * the records of all files are combined and deduplicated by id.
 */
export async function loadEnergyFiles(filenames: string[]): Promise<LoadedEnergyColumns> {
  if (filenames.length === 0) {
    throw new Error('The energy directory contains no energy files')
  }

  const texts = await Promise.all(
    filenames.map(async filename => {
      if (!FILENAME_PATTERN.test(filename)) {
        throw new Error(`Invalid energy file name: ${filename}`)
      }

      const response = await fetch(`/api/energy/file?name=${encodeURIComponent(filename)}`)
      if (!response.ok) {
        let message = `The request failed (${response.status})`
        try {
          const body: { error?: string } | null = await response.json()
          if (typeof body?.error === 'string') {
            message = body.error
          }
        } catch {
          // not a JSON error response
        }
        throw new Error(`${filename}: ${message}`)
      }
      return response.text()
    }),
  )

  const load = loadChain.then(async () => {
    const records = texts.flatMap((text, index) => {
      const sessionId = filenames[index].replace(/\.jsonl$/, '')
      return parseJsonl(text).map(record => withSessionId(record, sessionId))
    })

    const deduped = dedupeRecords(records).map(withEnergyLogId)
    if (deduped.length === 0) {
      throw new Error('The energy files contain no energy records')
    }

    const conn = await getConnection()

    const runFirstLogId = findRunFirstLogIds(
      deduped.map(record => ({
        sessionId: asString(record.session_id) ?? '',
        id: asString(record.energy_log_id),
        kind: asString(record.kind),
        agent: asString(record.agent),
        prompt: asString(record.prompt),
        time: asString(record.time),
      })),
    )

    const eventColumns = columnsOf(deduped)
    eventColumns.energy_samples = deduped.map(
      record => (Array.isArray(record.energy) ? record.energy.length : 0),
    )
    eventColumns.annotations = deduped.map(() => null)
    eventColumns.run_first_log_id = runFirstLogId
    await insertTable(conn, 'energy_events', eventColumns)

    const sampleRows: Array<Record<string, unknown>> = []
    const sampleRunFirstLogId: Array<string | null> = []
    deduped.forEach((record, index) => {
      const parent: Record<string, unknown> = { ...record }
      delete parent.energy

      for (const sample of Array.isArray(record.energy) ? record.energy : []) {
        if (sample === null || typeof sample !== 'object') {
          continue
        }

        sampleRows.push({ ...parent, ...(sample as Record<string, unknown>) })
        sampleRunFirstLogId.push(runFirstLogId[index])
      }
    })

    const sampleColumns = columnsOf(sampleRows)
    sampleColumns.annotations = sampleRows.map(() => null)
    sampleColumns.run_first_log_id = sampleRunFirstLogId
    await insertTable(conn, 'energy_samples', sampleColumns)

    return {
      events: Object.keys(eventColumns),
      samples: Object.keys(sampleColumns),
      annotations: [...PROMPT_ANNOTATION_COLUMNS],
    }
  })

  loadChain = load.catch(() => undefined)
  return load
}

/**
 * Mirrors the analysis's prompt-run annotations into DuckDB:
 *
 * - into the `prompt_annotations` table, one row per log id and tag, which
 *   the annotation filter conditions query. An annotation stores only the
 *   first log id of its run; the run's current log ids are resolved
 *   through the `run_first_log_id` column the load computed. This way the
 *   annotation keeps covering its whole run even when the analyzed source
 *   has grown since it was first made.
 * - into the `annotations` column of the two record tables, each log's tags
 *   joined as a comma-separated string for the raw data view
 *
 * Rebuilt from scratch on every call — after `loadEnergyFiles` filled
 * the tables, and again whenever an annotation changed.
 */
export async function syncPromptAnnotations(
  annotations: readonly PromptRunAnnotation[],
): Promise<void> {
  const load = loadChain.then(async () => {
    const runRows = await queryEnergy(`
      SELECT energy_log_id, run_first_log_id
      FROM energy_events
      WHERE energy_log_id IS NOT NULL AND run_first_log_id IS NOT NULL
    `)

    const firstOfLogId = new Map<string, string>()
    const logIdsOfFirst = new Map<string, string[]>()
    for (const row of runRows) {
      const logId = String(row['energy_log_id'])

      const firstLogId = String(row['run_first_log_id'])
      firstOfLogId.set(logId, firstLogId)

      const logIds = logIdsOfFirst.get(firstLogId)
      if (logIds === undefined) {
        logIdsOfFirst.set(firstLogId, [logId])
      } else {
        logIds.push(logId)
      }
    }

    const rows = annotations.flatMap(annotation => {
      const firstLogId = firstOfLogId.get(annotation.logId)
      const logIds = firstLogId !== undefined ? logIdsOfFirst.get(firstLogId) : undefined

      return (logIds ?? []).flatMap(energyLogId =>
        annotation.tags.map(tag => ({
          session_id: annotation.sessionId,
          energy_log_id: energyLogId,
          tag,
        })),
      )
    })

    const conn = await getConnection()
    await insertTable(conn, 'prompt_annotations', {
      session_id: rows.map(row => row.session_id),
      energy_log_id: rows.map(row => row.energy_log_id),
      tag: rows.map(row => row.tag),
    })

    for (const table of ['energy_events', 'energy_samples']) {
      await conn.query(`UPDATE ${table} SET annotations = NULL;`)
      await conn.query(`
        UPDATE ${table} SET annotations = tagged.tags
        FROM (
          SELECT energy_log_id, string_agg(tag, ', ' ORDER BY tag) AS tags
          FROM prompt_annotations
          GROUP BY energy_log_id
        ) tagged
        WHERE ${table}.energy_log_id = tagged.energy_log_id;
      `)
    }
  })

  loadChain = load.catch(() => undefined)
  return load
}

/**
 * A Perspective client whose queries run against the DuckDB database
 * that `loadEnergyFiles` filled.
 */
export async function getEnergyClient(): Promise<EnergyClient> {
  await bootstrapPerspective()
  const conn = await getConnection()
  const handler = new DuckDBHandler(conn)
  const port = await createMessageHandler(handler)
  return worker(Promise.resolve(port))
}

/**
 * Runs a SQL query against the DuckDB database that `loadEnergyFiles`
 * filled.
 */
export async function queryEnergy(
  sql: string,
  params?: unknown[],
): Promise<Array<Record<string, unknown>>> {
  const conn = await getConnection()

  if (params === undefined || params.length === 0) {
    const table = await conn.query(sql)
    return table.toArray() as Array<Record<string, unknown>>
  }

  const statement = await conn.prepare(sql)
  try {
    const table = await statement.query(...params)
    return table.toArray() as Array<Record<string, unknown>>
  } finally {
    await statement.close()
  }
}
