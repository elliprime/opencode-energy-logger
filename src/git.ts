import { execFile } from 'node:child_process'
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

/**
 * Reads the current git branch of the repository containing `cwd`.
 *
 * Resolves undefined when the directory is not inside a git repository, when
 * git is unavailable, or when the repository has no branch checked out
 * (detached HEAD). Never rejects.
 */
export function readGitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['branch', '--show-current'],
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: envWithoutGitRepo() },
      (error, stdout) => {
        if (error !== null) {
          debug(`git branch read failed: ${String(error)}`)
          resolve(undefined)
          return
        }

        const branch = stdout.trim()
        resolve(branch === '' ? undefined : branch)
      },
    )
  })
}
