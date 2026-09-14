import { unlinkSync, writeFileSync } from 'node:fs'

import { warn } from '../output.js'
import { startServer } from '../server.js'
import { deskLockPath, reviewDir } from '../state/desk.js'
import { stablePort } from '../state/identity.js'

import type { ReviewState } from '../types.js'
import type { CliArgs } from './args.js'

const MS_PER_MINUTE = 60_000
const SIGTERM_EXIT_CODE = 130
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

// Serve a persistent desk for an already-built state: bind the port, write the lock the agent
// subcommands read, and stay up across review rounds until interrupted.
export async function serveDesk(
	state: ReviewState,
	args: CliArgs,
): Promise<void> {
	const lockFile = deskLockPath(await reviewDir(state.root, state.session))
	// Default to the stable per-session port so a restarted desk keeps the same origin and an
	// already-open tab reconnects by itself (startServer falls back to a random port if a
	// foreign process holds it). Abandoned-desk reaper: exit after the idle timeout with no tab
	// polling and no agent attached (see startServer); minutes, 0 disables. Persistence + the
	// stable port make auto-exit safe.
	const host = resolveHost(args)
	const { url, lockUrl } = await startServer({
		state,
		port:
			typeof args.port === 'string'
				? Number(args.port)
				: stablePort(state.root, state.session),
		host,
		allowedHosts: readAllowedHosts(),
		open: args.open !== false,
		idleTimeoutMs: resolveIdleTimeoutMs(args),
	})

	// The lock records the loopback-reachable URL: the agent subcommands run on THIS machine
	// and reach the desk over loopback regardless of the (possibly non-loopback) browser URL.
	writeFileSync(
		lockFile,
		`${JSON.stringify({
			pid: process.pid,
			url: lockUrl,
			session: state.session,
			startedAt: new Date().toISOString(),
		})}\n`,
		'utf8',
	)
	installExitHandlers(lockFile)
	warnDeskReady(state, url, host)
	// The desk is persistent: keep serving across rounds until interrupted.
	await new Promise<never>(() => {})
}

function resolveHost(args: CliArgs): string {
	if (typeof args.host === 'string') return args.host
	const configuredHost = process.env.GALLEY_HOST
	if (configuredHost) return configuredHost
	return '127.0.0.1'
}

function readAllowedHosts(): string[] {
	return (process.env.GALLEY_ALLOWED_HOSTS ?? '')
		.split(',')
		.map(host => host.trim())
		.filter(Boolean)
}

function resolveIdleTimeoutMs(args: CliArgs): number | undefined {
	const minutes =
		typeof args['idle-timeout'] === 'string'
			? Number(args['idle-timeout'])
			: Number.NaN
	if (!Number.isFinite(minutes) || minutes < 0) return undefined
	return minutes * MS_PER_MINUTE
}

function installExitHandlers(lockFile: string): void {
	let isReleased = false
	const releaseLock = (): void => {
		try {
			unlinkSync(lockFile)
		} catch {
			/* already gone */
		}
	}
	const cleanup = (): void => {
		if (isReleased) return
		isReleased = true
		releaseLock()
	}
	process.on('exit', cleanup)
	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			cleanup()
			process.exit(SIGTERM_EXIT_CODE)
		})
	}
}

function warnDeskReady(state: ReviewState, url: string, host: string): void {
	const label =
		state.mode === 'repo'
			? state.session
			: `${state.mode}:${state.target ?? ''} [${state.session}]`
	warn(`Galley ${label}: ${url}`)
	// Bound beyond loopback: the desk API is unauthenticated and can run editor commands and
	// mutate git, so anyone who can reach this address controls the desk. Warn every launch.
	if (!LOOPBACK_HOSTS.has(host))
		warn(
			'⚠ Bound beyond loopback - the desk API is unauthenticated (runs editor commands, mutates git). Only expose it on a fully trusted network (e.g. a personal tailnet).',
		)
	warn('Live desk - the agent attaches with `galley await`. Ctrl-C to stop.')
}
