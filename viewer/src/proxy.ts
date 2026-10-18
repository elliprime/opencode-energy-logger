import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Guards the viewer's APIs.
 *
 * The APIs read energy records — prompts, URLs, models, branches — from any
 * folder on the machine, so they must only be reachable from the viewer
 * itself:
 *
 * - the request must be addressed to a loopback host, so the APIs cannot be
 *   reached through a network address, and DNS rebinding (a page whose
 *   hostname is re-resolved to this machine) cannot masquerade as the
 *   viewer
 * - a request that carries an `Origin` header — every browser request, so
 *   also cross-site form posts — must carry the viewer's own origin, so
 *   websites cannot drive the APIs from the user's browser.
 *
 * Requests without an `Origin` header, like the viewer app itself or local
 * tools such as curl, pass.
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get('host')
  if (host === null || !isLoopbackHost(host)) {
    return NextResponse.json({ error: 'The viewer only serves requests addressed to localhost' }, { status: 403 })
  }

  const origin = request.headers.get('origin')
  if (origin !== null && (origin === 'null' || !isSameOrigin(origin, host))) {
    return NextResponse.json({ error: 'The viewer only serves requests from its own origin' }, { status: 403 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}

/** The hostnames a local viewer may be addressed by. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  // an IPv6 host header looks like [::1]:3000 — keep the bracketed address
  const hostname = normalized.startsWith('[')
    ? normalized.slice(0, normalized.indexOf(']') + 1)
    : normalized.split(':', 1)[0]
  return LOOPBACK_HOSTS.has(hostname)
}

function isSameOrigin(origin: string, host: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}
