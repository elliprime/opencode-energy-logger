import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GIT_REPO_ENV_VARS, ensureIgnored, findRepoRoot, readGitBranch } from '../src/git.js'

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

describe.skipIf(!gitAvailable)('findRepoRoot', () => {
  it('should resolve the root of the repository at the directory', async () => {
    const repo = makeRepo('root-repo')

    expect(await findRepoRoot(repo)).toBe(realpathSync(repo))
  })

  it('should resolve the root from a subdirectory of the repository', async () => {
    const repo = makeRepo('root-subdir-repo')
    const nested = join(repo, 'nested', 'deeper')
    mkdirSync(nested, { recursive: true })

    expect(await findRepoRoot(nested)).toBe(realpathSync(repo))
  })

  it('should return undefined outside a git repository', async () => {
    const plain = join(root, 'not-a-root-repo')
    mkdirSync(plain)

    expect(await findRepoRoot(plain)).toBeUndefined()
  })
})

describe.skipIf(!gitAvailable)('ensureIgnored', () => {
  it('should add the path to the repository gitignore', async () => {
    const repo = makeRepo('ignore-repo')

    await ensureIgnored(repo, '.opencode/energy.local.json')

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('.opencode/energy.local.json\n')
    expect(spawnSync('git', ['-C', repo, 'check-ignore', '-q', '--', '.opencode/energy.local.json']).status).toBe(0)
  })

  it('should not append the path twice', async () => {
    const repo = makeRepo('ignore-twice-repo')

    await ensureIgnored(repo, '.opencode/energy.local.json')
    await ensureIgnored(repo, '.opencode/energy.local.json')

    const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8')
    expect(gitignore.split('\n').filter(line => line === '.opencode/energy.local.json')).toHaveLength(1)
  })

  it('should leave the gitignore untouched when another ignore source covers the path', async () => {
    const repo = makeRepo('ignore-covered-repo')
    const gitignore = join(repo, '.gitignore')
    writeFileSync(gitignore, 'node_modules/\n')
    appendFileSync(join(repo, '.git', 'info', 'exclude'), '.opencode/energy.local.json\n')

    await ensureIgnored(repo, '.opencode/energy.local.json')

    expect(readFileSync(gitignore, 'utf8')).toBe('node_modules/\n')
  })

  it('should append on its own line when the gitignore does not end with a line break', async () => {
    const repo = makeRepo('ignore-no-newline-repo')
    writeFileSync(join(repo, '.gitignore'), '# build output')

    await ensureIgnored(repo, '.opencode/energy.local.json')

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('# build output\n.opencode/energy.local.json\n')
  })

  it('should do nothing outside a git repository', async () => {
    const plain = join(root, 'not-a-repo-ignore')
    mkdirSync(plain)

    await expect(ensureIgnored(plain, '.opencode/energy.local.json')).resolves.toBeUndefined()
    expect(existsSync(join(plain, '.gitignore'))).toBe(false)
  })
})
