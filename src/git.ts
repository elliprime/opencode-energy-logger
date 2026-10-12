import { execFile, spawn } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { debug } from './log.js'

const GIT_TIMEOUT_MS = 5000

/**
 * Repository-scoped git environment variables. Inherited from an enclosing
 * git process — for example a hook running these tests, or a wrapper that
 * invoked git with `--git-dir` — they make spawned git commands operate on
 * that repository instead of the directory passed as cwd.
 */
export const GIT_REPO_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

function envWithoutGitRepo(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of GIT_REPO_ENV_VARS) {
    delete env[name]
  }
  return env
}

function git(args: string[], cwd: string): Promise<{ error: ExecFileException | null, stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: envWithoutGitRepo() },
      (error, stdout) => {
        resolve({ error, stdout })
      },
    )
  })
}

/**
 * Reads the current git branch of the repository containing `cwd`.
 *
 * Resolves undefined when the directory is not inside a git repository, when
 * git is unavailable, or when the repository has no branch checked out
 * (detached HEAD). Never rejects.
 */
export async function readGitBranch(cwd: string): Promise<string | undefined> {
  const { error, stdout } = await git(['branch', '--show-current'], cwd)
  if (error !== null) {
    debug(`git branch read failed: ${String(error)}`)
    return undefined
  }

  const branch = stdout.trim()
  return branch === '' ? undefined : branch
}

/**
 * Resolves the root directory of the repository containing `cwd`.
 *
 * Resolves undefined when the directory is not inside a git repository or
 * when git is unavailable. Never rejects.
 */
export async function findRepoRoot(cwd: string): Promise<string | undefined> {
  const { error, stdout } = await git(['rev-parse', '--show-toplevel'], cwd)
  if (error !== null) {
    debug(`git root lookup failed: ${String(error)}`)
    return undefined
  }

  const root = stdout.trim()
  return root === '' ? undefined : root
}

export async function isIgnored(repoRoot: string, relativePath: string): Promise<boolean | undefined> {
  const check = await git(['check-ignore', '-q', '--', relativePath], repoRoot)
  if (check.error === null) {
    return true
  }

  // exit code 1 means the path is not ignored. every other non-zero code is a
  // failed check, for example git being unavailable or not a repository
  if (check.error.code !== 1) {
    debug(`git ignore check failed: ${String(check.error)}`)
    return undefined
  }

  return false
}

export async function ensureIgnored(repoRoot: string, ...relativePaths: string[]): Promise<void> {
  const missing: string[] = []
  for (const relativePath of relativePaths) {
    // already ignored, or the check failed and there is nothing safe to do
    if (await isIgnored(repoRoot, relativePath) === false) {
      missing.push(relativePath)
    }
  }

  if (missing.length === 0) {
    return
  }

  const gitignore = join(repoRoot, '.gitignore')
  try {
    const existing = await readFile(gitignore, 'utf8').catch(() => '')
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await appendFile(gitignore, `${prefix}${missing.join('\n')}\n`)
  } catch (error) {
    debug(`gitignore update failed at ${gitignore}: ${String(error)}`)
  }
}

/**
 * Stages a path and everything below it in the repository index so the next
 * commit carries it. Resolves false when staging fails.
 */
export async function stagePath(repoRoot: string, relativePath: string): Promise<boolean> {
  const { error } = await git(['add', '--', relativePath], repoRoot)
  if (error !== null) {
    debug(`git add failed for ${relativePath} at ${repoRoot}: ${String(error)}`)
    return false
  }

  return true
}

/**
 * Reads a file as it exists in the repository's HEAD commit. The output is
 * streamed, so session views larger than a single write arrive in full.
 * Resolves undefined when the file or the commit is missing.
 */
export function showHeadFile(repoRoot: string, relativePath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', ['show', `HEAD:${relativePath}`], {
      cwd: repoRoot,
      env: envWithoutGitRepo(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let content = ''
    let settled = false

    const timeout = setTimeout(() => {
      child.kill()
    }, GIT_TIMEOUT_MS)

    const finish = (value: string | undefined) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        resolve(value)
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      content += chunk
    })
    child.on('error', () => finish(undefined))
    child.on('close', code => finish(code === 0 ? content : undefined))
  })
}
