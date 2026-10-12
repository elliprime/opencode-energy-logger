import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { appendEnergyRecord, flushEnergyRecords, energyViewPath, sessionStatePath } from '../src/energy.store.js'
import { GIT_REPO_ENV_VARS } from '../src/git.js'
import { flush } from '../src/log.js'

// the pre-commit hook runs these tests inside the enclosing `git commit`
// process (`git commit -a` sets GIT_INDEX_FILE to its live staging area),
// which would otherwise leak into every git command spawned below and point
// them at the enclosing repository
for (const name of GIT_REPO_ENV_VARS) {
  delete process.env[name]
}

// chmod-based directory failures do not apply to root or non-POSIX filesystems
const skip = process.getuid?.() === 0 || process.platform === 'win32'

const gitAvailable = spawnSync('git', ['--version']).status === 0

const root = mkdtempSync(join(tmpdir(), 'energy-logger-store-test-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

// settle the queued record writes and the debug lines they enqueue, so a
// later test with a different state directory cannot observe them
afterEach(async () => {
  delete process.env.ENERGY_LOGGER_DEBUG
  await flushEnergyRecords()
  await flush()
})

function stateDir(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  process.env.XDG_STATE_HOME = dir
  return dir
}

function record(sessionID: string, n: number): Record<string, unknown> {
  return { type: 'energy', time: `1970-01-01T00:00:0${n}.000Z`, sessionID, id: `rec_${sessionID}_${n}`, energy: [{ total_joules: n }] }
}

function lines(...records: Record<string, unknown>[]): string {
  return `${records.map(entry => JSON.stringify(entry)).join('\n')}\n`
}

function git(directory: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: directory })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr)}`)
  }
}

function makeRepo(name: string): string {
  const repo = join(root, name)
  mkdirSync(repo, { recursive: true })
  git(repo, 'init')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'commit', '--allow-empty', '-m', 'initial')
  return repo
}

function stagedEntries(repo: string): string[] {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo })
  return String(status.stdout).split('\n').filter(line => line.length > 0)
}

describe('appendEnergyRecord', () => {
  it('should append each record of a session to its own state file', async () => {
    stateDir('state-per-session')

    appendEnergyRecord(record('ses_1', 1))
    appendEnergyRecord(record('ses_1', 2))
    appendEnergyRecord(record('ses_2', 3))
    await flushEnergyRecords()

    expect(readFileSync(sessionStatePath('ses_1'), 'utf8')).toBe(lines(record('ses_1', 1), record('ses_1', 2)))
    expect(readFileSync(sessionStatePath('ses_2'), 'utf8')).toBe(lines(record('ses_2', 3)))
  })

  it('should only write the session state when no repository root is given', async () => {
    stateDir('state-no-repo-root')

    appendEnergyRecord(record('ses_1', 1))
    await flushEnergyRecords()

    expect(existsSync(sessionStatePath('ses_1'))).toBe(true)
  })

  it('should skip the session state when the record has no sessionID', async () => {
    const state = stateDir('state-no-session')

    appendEnergyRecord({ type: 'energy', energy: [{ total_joules: 1 }] })
    await flushEnergyRecords()

    expect(existsSync(join(state, 'opencode-energy-logger', 'sessions'))).toBe(false)
  })

  it('should sanitize session ids that are not filename safe', async () => {
    stateDir('state-unsafe-session')

    appendEnergyRecord(record('../escape', 1))
    await flushEnergyRecords()

    expect(readFileSync(sessionStatePath('escape'), 'utf8')).toBe(lines(record('../escape', 1)))
  })

  it('should write the session view into the repository', async () => {
    stateDir('state-view')
    const repo = join(root, 'view-repo')
    mkdirSync(repo)

    appendEnergyRecord(record('ses_1', 1), repo)
    appendEnergyRecord(record('ses_1', 2), repo)
    await flushEnergyRecords()

    expect(readFileSync(energyViewPath(repo, 'ses_1'), 'utf8')).toBe(lines(record('ses_1', 1), record('ses_1', 2)))
  })

  it('should regenerate the full view from the session state after it is lost', async () => {
    stateDir('state-regenerate')
    const repo = join(root, 'regenerate-repo')
    mkdirSync(repo)

    appendEnergyRecord(record('ses_1', 1), repo)
    await flushEnergyRecords()
    expect(existsSync(energyViewPath(repo, 'ses_1'))).toBe(true)

    // a lost working tree copy, for example from `git reset --hard`
    rmSync(energyViewPath(repo, 'ses_1'))

    appendEnergyRecord(record('ses_1', 2), repo)
    await flushEnergyRecords()

    expect(readFileSync(energyViewPath(repo, 'ses_1'), 'utf8')).toBe(lines(record('ses_1', 1), record('ses_1', 2)))
  })

  it('should regenerate the full view when it is replaced with an older version', async () => {
    stateDir('state-restore')
    const repo = join(root, 'restore-repo')
    mkdirSync(repo)

    appendEnergyRecord(record('ses_1', 1), repo)
    appendEnergyRecord(record('ses_1', 2), repo)
    await flushEnergyRecords()

    // a `git reset --hard` back to a commit holding an older view
    writeFileSync(energyViewPath(repo, 'ses_1'), lines(record('ses_1', 1)))

    appendEnergyRecord(record('ses_1', 3), repo)
    await flushEnergyRecords()

    expect(readFileSync(energyViewPath(repo, 'ses_1'), 'utf8')).toBe(
      lines(record('ses_1', 1), record('ses_1', 2), record('ses_1', 3)))
  })

  it.skipIf(skip)('should append to the view without replacing the file', async () => {
    stateDir('state-append')
    const repo = join(root, 'append-repo')
    mkdirSync(repo)

    appendEnergyRecord(record('ses_1', 1), repo)
    await flushEnergyRecords()

    const view = energyViewPath(repo, 'ses_1')
    chmodSync(view, 0o600)

    appendEnergyRecord(record('ses_1', 2), repo)
    await flushEnergyRecords()

    // a regeneration would replace the file and its mode with the durable
    // state's, an append leaves the file itself alone
    expect(statSync(view).mode & 0o777).toBe(0o600)
    expect(readFileSync(view, 'utf8')).toBe(lines(record('ses_1', 1), record('ses_1', 2)))
  })

  it('should rebuild the view when a same-size replacement changes it', async () => {
    stateDir('state-same-size')
    const repo = join(root, 'same-size-repo')
    mkdirSync(repo)

    appendEnergyRecord(record('ses_1', 1), repo)
    await flushEnergyRecords()

    // a branch switch replaces the view with a record of the same byte size
    const view = energyViewPath(repo, 'ses_1')
    const replacement = lines(record('ses_1', 2))
    expect(statSync(view).size).toBe(Buffer.byteLength(replacement))
    writeFileSync(view, replacement)

    appendEnergyRecord(record('ses_1', 3), repo)
    await flushEnergyRecords()

    // the local records come back: the replacement is rebuilt away instead of
    // appended onto
    expect(readFileSync(view, 'utf8')).toBe(lines(record('ses_1', 1), record('ses_1', 3)))
  })

  it.skipIf(skip)('should regenerate the full view after a failed view update', async () => {
    stateDir('state-recover')
    const repo = join(root, 'recover-repo')
    mkdirSync(repo)

    appendEnergyRecord(record('ses_1', 1), repo)
    await flushEnergyRecords()

    // the view cannot be written for a while, for example a full repo volume
    const view = energyViewPath(repo, 'ses_1')
    chmodSync(view, 0o400)

    appendEnergyRecord(record('ses_1', 2), repo)
    await flushEnergyRecords()

    chmodSync(view, 0o644)
    appendEnergyRecord(record('ses_1', 3), repo)
    await flushEnergyRecords()

    // the record whose update failed is not skipped: the view mirrors the
    // durable state again
    expect(readFileSync(view, 'utf8')).toBe(
      lines(record('ses_1', 1), record('ses_1', 2), record('ses_1', 3)))
  })

  it('should keep the records that arrived through git when rebuilding the view', async () => {
    stateDir('state-git-records')
    const repo = makeRepo('git-records-repo')
    mkdirSync(join(repo, '.energy'))
    writeFileSync(join(repo, '.energy', 'ses_1.jsonl'), lines(record('ses_1', 1), record('ses_1', 2)))
    git(repo, 'add', '.energy')
    git(repo, 'commit', '-m', 'records merged in from another machine')

    appendEnergyRecord(record('ses_1', 3), repo)
    await flushEnergyRecords()

    // the fresh durable state knows nothing of 1 and 2: they must survive
    expect(readFileSync(energyViewPath(repo, 'ses_1'), 'utf8')).toBe(
      lines(record('ses_1', 1), record('ses_1', 2), record('ses_1', 3)))
  })

  it('should keep the records of a session in the repository they were made in', async () => {
    stateDir('state-two-repos')
    const repoA = join(root, 'two-repos-a')
    const repoB = join(root, 'two-repos-b')
    mkdirSync(repoA)
    mkdirSync(repoB)

    appendEnergyRecord(record('ses_1', 1), repoA)
    await flushEnergyRecords()
    appendEnergyRecord(record('ses_1', 2), repoB)
    await flushEnergyRecords()
    appendEnergyRecord(record('ses_1', 3), repoA)
    await flushEnergyRecords()

    expect(readFileSync(energyViewPath(repoA, 'ses_1'), 'utf8')).toBe(lines(record('ses_1', 1), record('ses_1', 3)))
    expect(readFileSync(energyViewPath(repoB, 'ses_1'), 'utf8')).toBe(lines(record('ses_1', 2)))
  })

  it('should dedupe records sharing an id when merging the view with the git copy', async () => {
    stateDir('state-dedupe-merge')
    const repo = makeRepo('dedupe-merge-repo')
    mkdirSync(join(repo, '.energy'))

    const first = record('ses_1', 1)
    const shared = record('ses_1', 2)
    const fourth = record('ses_1', 4)
    writeFileSync(join(repo, '.energy', 'ses_1.jsonl'), lines(first, shared, fourth))
    git(repo, 'add', '.energy')
    git(repo, 'commit', '-m', 'records merged in from another machine')

    // the durable state holds the same record 2 again
    appendEnergyRecord(shared, repo)
    await flushEnergyRecords()

    expect(readFileSync(energyViewPath(repo, 'ses_1'), 'utf8')).toBe(lines(first, shared, fourth))
  })

  it('should dedupe the session views when flushing', async () => {
    stateDir('state-dedupe-flush')
    const repo = makeRepo('dedupe-flush-repo')

    appendEnergyRecord(record('ses_1', 1), repo)
    await flushEnergyRecords()

    // a union merge left a duplicated line in the working tree
    const view = energyViewPath(repo, 'ses_1')
    writeFileSync(view, lines(record('ses_1', 1), record('ses_1', 2), record('ses_1', 2)))

    await flushEnergyRecords()

    expect(readFileSync(view, 'utf8')).toBe(lines(record('ses_1', 1), record('ses_1', 2)))
  })

  it('should keep the view intact when a record is written during the flush', async () => {
    stateDir('state-flush-write')
    const repo = makeRepo('flush-write-repo')

    appendEnergyRecord(record('ses_1', 1), repo)
    await flushEnergyRecords()

    // the committed view holds records with a union-merge duplicate for the
    // flush dedupe to clean
    writeFileSync(join(repo, '.energy', 'ses_1.jsonl'), lines(record('ses_1', 1), record('ses_1', 2), record('ses_1', 2)))
    git(repo, 'add', '.energy')
    git(repo, 'commit', '-m', 'merged records')

    // a capture writes its record while the flush is already running: the
    // record write and the flush dedupe meet inside the same flush
    const flushing = flushEnergyRecords()
    appendEnergyRecord(record('ses_1', 3), repo)
    await flushing

    // neither the dedupe nor the record write may tear or drop the other
    expect(readFileSync(energyViewPath(repo, 'ses_1'), 'utf8')).toBe(
      lines(record('ses_1', 1), record('ses_1', 2), record('ses_1', 3)))
  })

  it.skipIf(skip)('should keep the view when the durable state cannot be read', async () => {
    stateDir('state-unreadable')
    const repo = join(root, 'unreadable-repo')
    mkdirSync(repo)

    appendEnergyRecord(record('ses_1', 1), repo)
    appendEnergyRecord(record('ses_1', 2), repo)
    await flushEnergyRecords()

    // the view is replaced behind the plugin's back while the durable state
    // is unreadable for a moment
    const view = energyViewPath(repo, 'ses_1')
    writeFileSync(view, lines(record('ses_1', 9)))
    chmodSync(sessionStatePath('ses_1', repo), 0o200)

    appendEnergyRecord(record('ses_1', 3), repo)
    await flushEnergyRecords()

    // the rebuild is aborted instead of writing the empty merge
    expect(readFileSync(view, 'utf8')).toBe(lines(record('ses_1', 9)))

    // and the next record repairs the view once the state is readable again
    chmodSync(sessionStatePath('ses_1', repo), 0o644)
    appendEnergyRecord(record('ses_1', 4), repo)
    await flushEnergyRecords()

    expect(readFileSync(view, 'utf8')).toBe(
      lines(record('ses_1', 1), record('ses_1', 2), record('ses_1', 3), record('ses_1', 4)))
  })

  it('should write the energy directory files once without touching existing ones', async () => {
    stateDir('state-dir-files')
    const repo = join(root, 'dir-files-repo')
    mkdirSync(repo)

    appendEnergyRecord(record('ses_1', 1), repo)
    await flushEnergyRecords()

    const attributes = join(repo, '.energy', '.gitattributes')
    const ignore = join(repo, '.energy', '.gitignore')
    expect(readFileSync(attributes, 'utf8')).toBe('*.jsonl merge=union\n')
    expect(readFileSync(ignore, 'utf8')).toBe('*.tmp\n')

    writeFileSync(attributes, '*.jsonl merge=ours\n')
    appendEnergyRecord(record('ses_1', 2), repo)
    await flushEnergyRecords()

    expect(readFileSync(attributes, 'utf8')).toBe('*.jsonl merge=ours\n')
  })

  it.skipIf(skip)('should retry a failed session state write after the directory becomes writable', async () => {
    const stateRoot = join(root, 'locked-state')
    mkdirSync(stateRoot)
    chmodSync(stateRoot, 0o500)
    process.env.XDG_STATE_HOME = stateRoot

    appendEnergyRecord(record('ses_1', 1))
    await new Promise(resolve => setTimeout(resolve, 100))
    chmodSync(stateRoot, 0o700)

    await flushEnergyRecords()

    expect(existsSync(sessionStatePath('ses_1'))).toBe(true)
  })
})

describe.skipIf(!gitAvailable)('appendEnergyRecord in a repository', () => {
  it('should stage the energy directory for the next commit', async () => {
    stateDir('state-stage')
    const repo = makeRepo('stage-repo')

    appendEnergyRecord(record('ses_1', 1), repo)
    await flushEnergyRecords()

    expect(stagedEntries(repo)).toEqual(expect.arrayContaining([
      'A  .energy/.gitattributes',
      'A  .energy/.gitignore',
      'A  .energy/ses_1.jsonl',
    ]))
  })

  it('should stage the whole energy directory including files of later sessions', async () => {
    stateDir('state-stage-all')
    const repo = makeRepo('stage-all-repo')

    appendEnergyRecord(record('ses_1', 1), repo)
    await flushEnergyRecords()
    git(repo, 'commit', '-m', 'energy snapshot')

    appendEnergyRecord(record('ses_2', 2), repo)
    await flushEnergyRecords()

    expect(stagedEntries(repo)).toContain('A  .energy/ses_2.jsonl')
  })

  it('should not stage and only warn once when the energy directory is gitignored', async () => {
    process.env.ENERGY_LOGGER_DEBUG = '1'
    const state = stateDir('state-ignored')
    const repo = makeRepo('ignored-repo')
    writeFileSync(join(repo, '.gitignore'), '.energy/\n')
    git(repo, 'add', '.gitignore')
    git(repo, 'commit', '-m', 'ignore energy')

    appendEnergyRecord(record('ses_1', 1), repo)
    appendEnergyRecord(record('ses_1', 2), repo)
    await flushEnergyRecords()
    await flush()

    expect(stagedEntries(repo)).toEqual([])
    expect(existsSync(energyViewPath(repo, 'ses_1'))).toBe(true)
    const log = readFileSync(join(state, 'opencode-energy-logger', 'energy-logger.log'), 'utf8')
    expect(log.match(/is gitignored/g)).toHaveLength(1)
  })

  it('should warn when ignore rules keep the record files out of the repository', async () => {
    process.env.ENERGY_LOGGER_DEBUG = '1'
    const state = stateDir('state-file-ignored')
    const repo = makeRepo('file-ignored-repo')
    writeFileSync(join(repo, '.gitignore'), '*.jsonl\n')
    git(repo, 'add', '.gitignore')
    git(repo, 'commit', '-m', 'ignore record files')

    appendEnergyRecord(record('ses_1', 1), repo)
    await flushEnergyRecords()
    await flush()

    // the templates stage but the record file itself can never reach a commit
    expect(stagedEntries(repo)).toEqual(['A  .energy/.gitattributes', 'A  .energy/.gitignore'])
    const log = readFileSync(join(state, 'opencode-energy-logger', 'energy-logger.log'), 'utf8')
    expect(log.match(/is gitignored/g)).toHaveLength(1)
  })

  it('should merge energy views from diverged branches without conflicts', async () => {
    stateDir('state-merge')
    const repo = makeRepo('merge-repo')
    git(repo, 'checkout', '-b', 'trunk')

    appendEnergyRecord(record('ses_1', 1), repo)
    appendEnergyRecord(record('ses_1', 2), repo)
    await flushEnergyRecords()
    git(repo, 'add', '.energy')
    git(repo, 'commit', '-m', 'energy on trunk')

    git(repo, 'checkout', '-b', 'feature/audit')
    appendEnergyRecord(record('ses_1', 3), repo)
    appendEnergyRecord(record('ses_2', 5), repo)
    await flushEnergyRecords()
    git(repo, 'add', '.energy')
    git(repo, 'commit', '-m', 'energy on branch')

    git(repo, 'checkout', 'trunk')
    appendEnergyRecord(record('ses_1', 4), repo)
    await flushEnergyRecords()
    git(repo, 'add', '.energy')
    git(repo, 'commit', '-m', 'more energy on trunk')

    const merge = spawnSync('git', ['merge', '--no-edit', 'feature/audit'], { cwd: repo })
    expect(merge.status).toBe(0)

    expect(readFileSync(energyViewPath(repo, 'ses_1'), 'utf8')).toBe(
      lines(record('ses_1', 1), record('ses_1', 2), record('ses_1', 3), record('ses_1', 4)))
    expect(readFileSync(energyViewPath(repo, 'ses_2'), 'utf8')).toBe(lines(record('ses_2', 5)))
  })
})
