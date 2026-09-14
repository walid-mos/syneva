import { HTTP_FORBIDDEN, fail } from './http.js'

import type { IncomingMessage, ServerResponse } from 'node:http'

// Wrap a bare IPv6 literal in brackets for use as a URL/authority host; leave names and IPv4
// (and already-bracketed literals) untouched. An IPv6 address is the only host that needs it.
function urlHost(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

// The loopback authorities #51 has always trusted. A non-loopback bind EXTENDS this set (never
// replaces it) so the same-machine agent CLI, which talks to 127.0.0.1 regardless of bind address,
// keeps working.
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const
// Host strings that mean "this machine's loopback" (no widening) and "every interface" (a wildcard
// bind has no single address to advertise, so loopback still reaches it).
const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]'])

export type Binding = {
	// The URL a browser (possibly on another device) uses - printed and opened.
	browserHost: string
	// The URL the same-machine agent CLI reaches the desk at, recorded in the desk lock.
	lockHost: string
	// The host names whose `name:port` authority the origin guard accepts, beyond the port.
	allowedHosts: string[]
}

// Derive the browser URL host, the lock-file URL host, and the origin-guard authority names from
// the bind address. Pure (hostname + env injected) so it's unit-testable without binding exotic
// addresses. The default (loopback) path adds NOTHING to the loopback authority set and keeps both
// URLs on 127.0.0.1 - byte-for-byte the pre-flag behavior. A wildcard bind (0.0.0.0/::) advertises
// the machine's hostname to the browser but keeps the lock on loopback (still reachable). A specific
// non-loopback bind can't be reached over loopback, so both URLs use that exact address. os.hostname()
// and any GALLEY_ALLOWED_HOSTS (a MagicDNS FQDN differs from the short hostname) widen the guard.
export function resolveBinding(
	host: string,
	hostname: string,
	allowedHostsEnv: string[],
): Binding {
	if (LOOPBACK_BINDS.has(host))
		return {
			browserHost: '127.0.0.1',
			lockHost: '127.0.0.1',
			allowedHosts: [...LOOPBACK_HOSTS],
		}
	const wildcard = WILDCARD_BINDS.has(host)
	const extra = [
		hostname,
		...(wildcard ? [] : [urlHost(host)]),
		...allowedHostsEnv,
	].filter(Boolean)
	return {
		browserHost: wildcard ? hostname : urlHost(host),
		lockHost: wildcard ? '127.0.0.1' : urlHost(host),
		allowedHosts: [...LOOPBACK_HOSTS, ...extra],
	}
}

// Lock the desk to its own trusted origin. stablePort binds a *deterministic* port, so the origin is
// guessable - without this, any page the reviewer has open in the same browser could POST to the
// state-changing routes (CSRF: /api/reset wipes the review, /api/shutdown kills the desk) or read the
// diff off-machine (the dropped wildcard CORS). The Host check defeats DNS-rebinding - a rebinding
// attack arrives with the attacker's hostname in Host - so only the desk's own authorities pass.
// `allowedHosts` is the loopback set by default (a loopback bind), EXTENDED with the machine's
// hostname / bound address / GALLEY_ALLOWED_HOSTS when bound beyond loopback (see resolveBinding),
// never widened otherwise. The Origin check blocks cross-site POSTs; header-less callers (curl and
// the `galley await`/`comment`/`reload`/`status` CLI, which target 127.0.0.1 and send no Origin) stay
// allowed. Returns false once it has answered 403.
export function originAllowed(
	req: IncomingMessage,
	res: ServerResponse,
	port: number,
	allowedHosts: readonly string[],
): boolean {
	const authorities = allowedHosts.map(host => `${host}:${port}`)
	const { host } = req.headers
	if (!host || !authorities.includes(host)) {
		fail(res, {
			status: HTTP_FORBIDDEN,
			code: 'FORBIDDEN_HOST',
			error: `Host "${host ?? ''}" is not this desk.`,
			fix: 'Reach the desk at its 127.0.0.1 origin.',
		})
		return false
	}
	if (req.method !== 'POST') return true
	const { origin } = req.headers
	if (!origin || authorities.some(a => origin === `http://${a}`)) return true
	fail(res, {
		status: HTTP_FORBIDDEN,
		code: 'FORBIDDEN_ORIGIN',
		error: `Cross-site request from origin "${origin}" is not allowed.`,
		fix: 'The desk only accepts same-origin requests.',
	})
	return false
}
