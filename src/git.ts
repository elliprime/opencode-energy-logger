import { execFile } from 'node:child_process'
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

export async function ensureIgnored(repoRoot: string, relativePath: string): Promise<void> {
  const check = await git(['check-ignore', '-q', '--', relativePath], repoRoot)
  if (check.error === null) {
    return // already ignored
  }

  // exit code 1 means the path is not ignored. every other non-zero code is a
  // failed check, for example git being unavailable or not a repository
  if (check.error.code !== 1) {
    debug(`git ignore check failed: ${String(check.error)}`)
    return
  }

  const gitignore = join(repoRoot, '.gitignore')
  try {
    const existing = await readFile(gitignore, 'utf8').catch(() => '')
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await appendFile(gitignore, `${prefix}${relativePath}\n`)
  } catch (error) {
    debug(`gitignore update failed at ${gitignore}: ${String(error)}`)
  }
}
