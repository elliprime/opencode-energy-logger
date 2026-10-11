import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GIT_REPO_ENV_VARS, readGitBranch } from '../src/git.js'

// the pre-commit hook runs these tests inside the enclosing `git commit`
// process (`git commit -a` sets GIT_INDEX_FILE to its live staging area),
// which would otherwise leak into every git command spawned below and point
// them at the enclosing repository
for (const name of GIT_REPO_ENV_VARS) {
  delete process.env[name]
}

const gitAvailable = spawnSync('git', ['--version']).status === 0

const root = mkdtempSync(join(tmpdir(), 'energy-logger-git-test-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function git(directory: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: directory })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr)}`)
  }
}

function makeRepo(name: string, branch = 'feature/energy'): string {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  git(directory, 'init')
  git(directory, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'initial')
  git(directory, 'checkout', '-b', branch)
  return directory
}

describe.skipIf(!gitAvailable)('readGitBranch', () => {
  it('should read the current branch of the repository at the directory', async () => {
    const repo = makeRepo('repo')

    expect(await readGitBranch(repo)).toBe('feature/energy')
  })

  it('should read the branch from a subdirectory of the repository', async () => {
    const repo = makeRepo('subdir-repo')
    const nested = join(repo, 'nested', 'deeper')
    mkdirSync(nested, { recursive: true })

    expect(await readGitBranch(nested)).toBe('feature/energy')
  })

  it('should return undefined outside a git repository', async () => {
    const plain = join(root, 'not-a-repo')
    mkdirSync(plain)

    expect(await readGitBranch(plain)).toBeUndefined()
  })

  it('should return undefined for a detached HEAD', async () => {
    const repo = makeRepo('detached-repo')
    git(repo, 'checkout', '--detach')

    expect(await readGitBranch(repo)).toBeUndefined()
  })

  it('should ignore repository environment variables of the calling context', async () => {
    const repo = makeRepo('env-repo')
    const other = makeRepo('env-other-repo', 'feature/other')

    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = join(other, '.git')
    try {
      expect(await readGitBranch(repo)).toBe('feature/energy')
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_DIR
      } else {
        process.env.GIT_DIR = previous
      }
    }
  })
})
