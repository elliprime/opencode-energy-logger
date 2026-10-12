import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { isIgnored, showHeadFile, stagePath } from './git.js'
import { debug, logFilePath } from './log.js'

const energyDirName = '.energy'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

/** Records arriving within this window share one staging run. */
const STAGE_SETTLE_MS = 500

/**
 * Path of a session's durable state file below the XDG state directory, scoped
 * to the repository the records were made in.
 *
 * The durable state file is held outside the git repo for the current session,
 * so the user can't accidentally delete it and lose all the energy data
 * recorded up till then. A session used in several repositories keeps a state
 * file per repository, so no repository ever sees another's records.
 */
export function sessionStatePath(sessionID: string, repoRoot?: string): string {
  const sessions = join(dirname(logFilePath()), 'sessions')
  return repoRoot === undefined
    ? join(sessions, `${sessionID}.jsonl`)
    : join(sessions, createHash('md5').update(repoRoot).digest('hex').slice(0, 16), `${sessionID}.jsonl`)
}

/**
 * Path of a session's file inside a repository's `.energy` directory.
 *
 * This file is the one that will be added to repo and included in pull requests.
 */
export function energyViewPath(repoRoot: string, sessionID: string): string {
  return join(repoRoot, energyDirName, `${sessionID}.jsonl`)
}

const pendingWrites = new Set<Promise<void>>()

// record writes run one at a time
let writeQueue: Promise<void> = Promise.resolve()

// the tail of the view file each record write last produced: a view that no longer matches
// was replaced (a branch switch or `git reset --hard`) and is rebuilt from the
// durable state and the copy in git instead of appended to
const views = new Map<string, { size: number, tail: string }>()

// repositories with view changes not staged yet
const needsStaging = new Set<string>()
const lastStagedAt = new Map<string, number>()

// repositories whose views were written this session, deduplicated at the flush
const touchedRepos = new Set<string>()

export function appendEnergyRecord(record: Record<string, unknown>, repoRoot?: string): void {
  const pending = writeQueue
    .then(() => writeEnergyRecord(record, repoRoot))
    .finally(() => pendingWrites.delete(pending))

  pendingWrites.add(pending)

  // a failed write must not stop the queue
  writeQueue = pending.catch(() => {})
}

function normalizeSessionID(sessionID: string): string {
  // session IDs will be used as filenames, so we remove everything that would not be valid
  // in a filename
  sessionID = sessionID.replace(/[^A-Za-z0-9_-]/g, '')
  sessionID = sessionID.substring(0, 128)
  return sessionID
}

async function writeEnergyRecord(record: Record<string, unknown>, repoRoot: string | undefined): Promise<void> {
  let sessionID = typeof record.sessionID === 'string' ? record.sessionID : undefined
  if (sessionID === undefined) {
    debug('energy record without sessionID gets no session state')
    return
  }

  sessionID = normalizeSessionID(sessionID)

  const line = `${JSON.stringify(record)}\n`
  const statePath = sessionStatePath(sessionID, repoRoot)
  const appended = await appendWithRetries(statePath, line)

  if (repoRoot !== undefined) {
    // a record that never reached the durable state must not reach the view,
    // so the view keeps mirroring it
    await updateEnergyView(repoRoot, sessionID, statePath, appended ? line : undefined)
  }
}

async function appendWithRetries(path: string, line: string): Promise<boolean> {
  for (let retries = 0; ; ++retries) {
    try {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, line)
      return true
    } catch (error) {
      debug(`energy session state write failed at ${path}: ${String(error)}`)

      if (retries >= MAX_RETRIES) {
        return false
      }

      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}

/**
 * Mirrors a record into the git repository's `.energy` directory and keeps the
 * directory staged for the next commit. The view is appended to while it is
 * exactly the file the previous write produced; anything else — a branch
 * switch or `git reset --hard` replaced it — is regenerated from the durable
 * state, so no captured record can be lost from the repository.
 */
async function updateEnergyView(
  repoRoot: string,
  sessionID: string,
  durableStatePath: string,
  line: string | undefined,
): Promise<void> {
  const energyDir = join(repoRoot, energyDirName)
  const viewPath = energyViewPath(repoRoot, sessionID)

  try {
    await mkdir(energyDir, { recursive: true })
    await ensureEnergyDirGitFiles(energyDir)
    await appendOrRegenerateView(viewPath, repoRoot, sessionID, durableStatePath, line)
  } catch (error) {
    // forget the file we last wrote, so the next record rebuilds the view
    // from the durable state instead of appending onto a view that missed it
    views.delete(viewPath)
    debug(`energy view update failed at ${energyDir}: ${String(error)}`)
    return
  }

  touchedRepos.add(repoRoot)
  needsStaging.add(repoRoot)
  await warnIfViewIgnored(repoRoot, sessionID)
  await stageIfSettled(repoRoot)
}

async function appendOrRegenerateView(
  viewPath: string,
  repoRoot: string,
  sessionID: string,
  durableStatePath: string,
  line: string | undefined,
): Promise<void> {
  const expected = views.get(viewPath)

  // if the size of the view file is what we expect and it still ends with the
  // line we appended last, we don't need to rebuild it, just append the line to
  // it
  if (
    line !== undefined
    && expected !== undefined
    && (await viewSize(viewPath)) === expected.size
    && await endsWith(viewPath, expected.tail)
  ) {
    await appendFile(viewPath, line)
    views.set(viewPath, { size: expected.size + Buffer.byteLength(line), tail: line })
    return
  }

  // file rebuild only happens when the view file changed outside of this process or if we have not yet
  // written to the file yet (no entry in views): the durable state is merged with the copy in git,
  // so records that arrived through pulls and merges survive alongside the local ones
  const content = await mergedView(repoRoot, sessionID, durableStatePath)
  await writeAtomic(viewPath, content)
  views.set(viewPath, { size: (await viewSize(viewPath)) ?? 0, tail: trailingLine(content) })
}

function trailingLine(content: string): string {
  return content.slice(content.lastIndexOf('\n', Math.max(0, content.length - 2)) + 1)
}

async function endsWith(viewFilePath: string, tail: string): Promise<boolean> {
  if (tail === '') {
    return true
  }

  const handle = await open(viewFilePath, 'r').catch(() => undefined)
  if (handle === undefined) {
    return false
  }

  try {
    const bytes = Buffer.byteLength(tail)
    const { size } = await handle.stat()
    if (size < bytes) {
      return false
    }

    const buffer = Buffer.alloc(bytes)
    await handle.read(buffer, 0, bytes, size - bytes)
    return buffer.toString('utf8') === tail
  } finally {
    await handle.close()
  }
}

/** The view content: the durable state merged with the copy in git, deduplicated by record id. */
async function mergedView(repoRoot: string, sessionID: string, durableStatePath: string): Promise<string> {
  // note: both read entirely in memory. we do not expect energy logs for a single session to be
  // large enough for that to be a problem
  const [durable, inGit] = await Promise.all([
    readDurable(durableStatePath),
    showHeadFile(repoRoot, `${energyDirName}/${sessionID}.jsonl`),
  ])
  return formatRecords(dedupeRecords(durable, inGit ?? ''))
}

/**
 * The durable state's content. A missing file is the fresh session case, a
 * failed read stops the rebuild so the view keeps what it has.
 */
async function readDurable(durableStatePath: string): Promise<string> {
  try {
    return await readFile(durableStatePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '' // missing file
    }

    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function tryParseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * One line per record: keyed by the record id (the raw line for records that
 * predate ids), first occurrence wins, ordered by the record's time.
 */
function dedupeRecords(...sources: string[]): string[] {
  const records = new Map<string, { time: string, line: string }>()

  for (const source of sources) {
    for (const line of source.split('\n')) {
      if (line === '') {
        continue
      }

      const record = tryParseRecord(line)
      const key = record !== undefined && typeof record.id === 'string' ? record.id : line
      if (records.has(key)) {
        continue
      }

      const time = record !== undefined && typeof record.time === 'string' ? record.time : ''
      records.set(key, { time, line })
    }
  }

  return [...records.values()]
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(entry => entry.line)
}

function formatRecords(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

async function viewSize(viewPath: string): Promise<number | undefined> {
  try {
    return (await stat(viewPath)).size
  } catch {
    // a missing view is the reset case: it gets regenerated
    return undefined
  }
}

async function ensureEnergyDirGitFiles(energyDir: string): Promise<void> {
  await writeFileOnce(join(energyDir, '.gitattributes'), '*.jsonl merge=union\n')
  await writeFileOnce(join(energyDir, '.gitignore'), '*.tmp\n')
}

async function writeFileOnce(file: string, content: string): Promise<void> {
  if (existsSync(file)) {
    return
  }

  await writeAtomic(file, content)
}

// each atomic write gets its own temporary file: concurrent writers in one
// process would otherwise share and tear it
let writeCounter = 0

async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.${++writeCounter}.tmp`
  await writeFile(temp, content)

  try {
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

const warnedIgnored = new Set<string>()

function warnIgnored(repoRoot: string, what: string): void {
  if (warnedIgnored.has(repoRoot)) {
    return
  }

  warnedIgnored.add(repoRoot)
  debug(`the ${what} at ${repoRoot} is gitignored: remove it from the ignore files so energy records reach the repository history`)
}

// session files whose ignore status was checked already
const checkedViews = new Set<string>()

/** Warns once per repository when ignore rules keep the session's records out of it. */
async function warnIfViewIgnored(repoRoot: string, sessionID: string): Promise<void> {
  const checked = `${repoRoot}:${energyDirName}/${sessionID}.jsonl`
  if (checkedViews.has(checked)) {
    return
  }
  checkedViews.add(checked)

  if (await isIgnored(repoRoot, `${energyDirName}/${sessionID}.jsonl`) === true) {
    warnIgnored(repoRoot, 'session record files')
  }
}

/**
 * Removes records a git merge duplicated from the repository's view copies,
 * so a union merge cannot make one record count twice.
 */
async function dedupeEnergyDir(repoRoot: string): Promise<void> {
  const energyDir = join(repoRoot, energyDirName)
  const entries = await readdir(energyDir).catch(() => [] as string[])

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) {
      continue
    }

    const viewPath = join(energyDir, entry)

    // the read and the rewrite run sequentially along with record writes, so a
    // record of this session cannot slip between them and be clobbered by the
    // stale copy read here
    await enqueueViewWork(async () => {
      try {
        const content = await readFile(viewPath, 'utf8').catch(() => undefined)
        if (content === undefined) {
          return
        }

        const deduped = formatRecords(dedupeRecords(content))
        if (deduped === content) {
          return
        }

        await writeAtomic(viewPath, deduped)
        views.set(viewPath, { size: Buffer.byteLength(deduped), tail: trailingLine(deduped) })
        needsStaging.add(repoRoot)
      } catch (error) {
        // a failed rewrite is repaired by the next record's rebuild and must
        // not reject the flush
        debug(`energy view dedupe failed at ${viewPath}: ${String(error)}`)
      }
    })
  }
}

function enqueueViewWork(work: () => Promise<void>): Promise<void> {
  const pending = writeQueue.then(work)
  // a failed unit must not stop the queue
  writeQueue = pending.catch(() => {})
  return pending
}

/**
 * TODO: if we use a debounce wrapper, should be able to get rid of lastStagedAt.
 * Stages the repository's energy directory, at most once per settle window so
 * a burst of records shares one staging run.
 */
function stageIfSettled(repoRoot: string): Promise<void> {
  const now = Date.now()
  const last = lastStagedAt.get(repoRoot)
  if (last !== undefined && now - last < STAGE_SETTLE_MS) {
    // within the window: a later record or the flush completes the staging
    return Promise.resolve()
  }

  return stageMarked(repoRoot)
}

/** Stages the repository's pending changes, keeping the mark when the run does not complete. */
async function stageMarked(repoRoot: string): Promise<void> {
  needsStaging.delete(repoRoot)
  lastStagedAt.set(repoRoot, Date.now())

  if (!(await stageEnergyDir(repoRoot))) {
    // the changes are still unstaged: a later record or flush retries
    needsStaging.add(repoRoot)
  }
}

async function stageEnergyDir(repoRoot: string): Promise<boolean> {
  // note: ignored can be null when git isn't installed or something is wrong
  // with the environment
  const ignored = await isIgnored(repoRoot, energyDirName)
  if (ignored !== false) {
    if (ignored === true) {
      warnIgnored(repoRoot, `${energyDirName} directory`)
      return true
    }

    // an ignored directory is left alone by choice; a failed check is
    // retried
    return false
  }

  return stagePath(repoRoot, energyDirName)
}

/**
 * Awaits every energy record write started so far, including writes waiting on
 * a retry, deduplicates the session views a git merge may have duplicated, and
 * stages records that a settle window deferred.
 *
 * A single pass over the marked work: no records can arrive while it runs,
 * because the plugin's cleanup awaits its in-flight captures before flushing,
 * so every record has been enqueued by the time the flush starts.
 */
export async function flushEnergyRecords(): Promise<void> {
  await Promise.allSettled([...pendingWrites])

  for (const repoRoot of touchedRepos) {
    await dedupeEnergyDir(repoRoot)
  }

  for (const repoRoot of [...needsStaging]) {
    await stageMarked(repoRoot)
  }
}
