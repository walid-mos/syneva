import type { Server } from 'node:http'
import type { ReviewState } from '../types.js'

export type ServerOptions = {
	state: ReviewState
	port?: number
	// Bind address. Defaults to 127.0.0.1 (loopback-only) - the desk stays local unless explicitly
	// opted into a broader bind (--host / GALLEY_HOST). See resolveBinding for how this shapes the
	// origin guard, the printed URL, and the lock-file URL.
	host?: string
	// Extra host names (beyond the machine's hostname/bound address) whose authority the origin guard
	// trusts when bound non-loopback - GALLEY_ALLOWED_HOSTS, for exotic names like a MagicDNS FQDN.
	allowedHosts?: string[]
	open?: boolean
	// Test seam: lets server.test.ts assert the resolved editor invocation without
	// actually launching anything.
	runEditorCommand?: (command: string, args: string[]) => Promise<void>
	// Test seam: TTL for the ephemeral agent-activity line (default 90s).
	statusTtlMs?: number
	// Auto-exit after this long with no HTTP activity (default 2h; 0 disables). An open
	// tab polls /api/state and a waiting agent holds /api/await-send, so "idle" really
	// means abandoned - no tab, no agent. State is persisted on every save and the desk
	// is idempotent on a stable port, so restarting later restores everything.
	idleTimeoutMs?: number
	// Test seam: called instead of process.exit(0) when the desk shuts itself down
	// (idle timeout or POST /api/shutdown).
	onShutdown?: (reason: 'idle' | 'stop') => void
}

export type ServerHandle = {
	server: Server
	// The URL to open/print - reachable from the reviewer's browser (hostname-based when bound
	// non-loopback). Equals lockUrl for the default loopback bind.
	url: string
	// The URL the same-machine agent CLI reaches the desk at (recorded in the desk lock) - loopback
	// for a loopback/wildcard bind, the bound address for a specific non-loopback bind.
	lockUrl: string
}

// The bind address when --host / GALLEY_HOST says nothing.
export const DEFAULT_HOST = '127.0.0.1'
