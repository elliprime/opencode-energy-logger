import { Readable } from 'node:stream'
import { EnergySourceError, type EnergyDirectory } from './types'
import { energyDirectoryFromEntries, scopeToSubPath, type SourceEntry } from './discover'
import { readTarEntries } from './tar-entries'

const FORGEJO_REF_KINDS = new Set(['branch', 'tag', 'commit', 'rev'])

/**
 * Creates an energy directory from a link to a GitHub or Forgejo
 * repository folder that contains a `.energy` folder or `ses_*.jsonl`
 * files.
 *
 * The repository tarball is downloaded and read as a stream, so only the
 * energy files end up in memory.
 */
export async function energyDirectoryFromRepositoryUrl(input: string): Promise<EnergyDirectory> {
  const location = parseRepositoryUrl(input)
  const ref = location.ref ?? (await defaultBranch(location))
  const archiveUrl = tarballUrl(location, ref)

  const response = await fetch(archiveUrl, {
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null)

  if (response === null || !response.ok || response.body === null) {
    const status = response === null ? 'the host could not be reached' : `${response.status} ${response.statusText}`
    throw new EnergySourceError(`Could not download ${archiveUrl}: ${status}`)
  }

  let entries: SourceEntry[] = await readTarEntries(nodeStream(response.body), `the tarball of ${input}`)
  if (location.subPath !== undefined) {
    entries = scopeToSubPath(entries, location.subPath)
  }
  return energyDirectoryFromEntries(entries, `in ${input}`)
}

interface RepositoryLocation {
  readonly host: string
  readonly origin: string
  readonly owner: string
  readonly repository: string
  readonly ref?: string
  readonly subPath?: string
}

/**
 * Parses repository links like
 *
 * - `https://github.com/owner/repository`
 * - `https://github.com/owner/repository/tree/branch/sub/folder`
 * - `https://forgejo.example/owner/repository`
 * - `https://forgejo.example/owner/repository/src/branch/main/sub/folder`
 */
function parseRepositoryUrl(input: string): RepositoryLocation {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new EnergySourceError(`Not a valid URL: ${input}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EnergySourceError(`Not a repository URL: ${input}`)
  }

  const segments = url.pathname
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => decodeURIComponent(segment))
  if (segments.length < 2) {
    throw new EnergySourceError(`Not a repository URL, expected e.g. https://github.com/owner/repository: ${input}`)
  }

  const location: RepositoryLocation = {
    host: url.host.replace(/^www\./, ''),
    origin: url.origin,
    owner: segments[0],
    repository: segments[1].replace(/\.git$/, ''),
  }
  const [kind, selector, ...rest] = segments.slice(2)

  if (kind === undefined) {
    return location
  }

  if (kind === 'tree' && isGitHub(location.host)) {
    // https://github.com/owner/repository/tree/<ref>/sub/folder
    if (selector === undefined || selector.length === 0) {
      throw new EnergySourceError(`The repository URL is missing its branch: ${input}`)
    }

    return {
      ...location,
      ref: selector,
      subPath: rest.length > 0 ? rest.join('/') : undefined,
    }
  }

  if (kind === 'src' && !isGitHub(location.host)) {
    // https://forgejo.example/owner/repository/src/<branch|tag|commit|rev>/<ref>/sub/folder
    if (selector === undefined || !FORGEJO_REF_KINDS.has(selector)) {
      throw new EnergySourceError(`Not a Forgejo repository URL, expected .../src/branch/<branch>: ${input}`)
    }
    if (rest.length === 0) {
      throw new EnergySourceError(`The repository URL is missing its branch: ${input}`)
    }

    return {
      ...location,
      ref: rest[0],
      subPath: rest.length > 1 ? rest.slice(1).join('/') : undefined,
    }
  }

  throw new EnergySourceError(`Unsupported repository URL path, expected a /tree/... (GitHub) or /src/branch/... (Forgejo) link: ${input}`)
}

function isGitHub(host: string): boolean {
  return host === 'github.com' || host.endsWith('.github.com')
}

/**
 * The ref the tarball is downloaded for: GitHub resolves `HEAD` to the
 * default branch, Forgejo needs to be asked for it.
 */
async function defaultBranch(location: RepositoryLocation): Promise<string> {
  if (isGitHub(location.host)) {
    return 'HEAD'
  }

  const api = `${location.origin}/api/v1/repos/${location.owner}/${location.repository}`
  const response = await fetch(api, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)

  if (response === null || !response.ok) {
    const status = response === null ? 'the host could not be reached' : `${response.status} ${response.statusText}`
    throw new EnergySourceError(`Could not determine the default branch of ${location.owner}/${location.repository} (${status}); link the branch directly`)
  }

  const repository = await response.json().catch(() => null) as { default_branch?: string } | null
  if (repository?.default_branch === undefined || repository.default_branch.length === 0) {
    throw new EnergySourceError(`Could not determine the default branch of ${location.owner}/${location.repository}; link the branch directly`)
  }

  return repository.default_branch
}

function tarballUrl(location: RepositoryLocation, ref: string): string {
  if (isGitHub(location.host)) {
    return `https://codeload.github.com/${location.owner}/${location.repository}/tar.gz/${ref}`
  }

  return `${location.origin}/${location.owner}/${location.repository}/archive/${ref}.tar.gz`
}

function nodeStream(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream)
}
