import { warn } from '../../outbound/console.js'

import type { ServerOptions } from './options.js'

const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const MS_PER_SECOND = 1000

const IDLE_CHECK_MIN_MS = 10
const IDLE_CHECK_MAX_MS = SECONDS_PER_MINUTE * MS_PER_SECOND
// One check per quarter of the idle window: often enough that a test can use a tiny timeout,
// rarely enough to be free.
const IDLE_CHECK_DIVISOR = 4
const DEFAULT_IDLE_HOURS = 2
const DEFAULT_IDLE_MS =
	DEFAULT_IDLE_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND

export type IdleWatchdog = {
	requestStarted(): void
	requestFinished(): void
	stop(): void
}

// Desk lifecycle: without this, an abandoned desk (tab closed, agent gone) serves forever and
// desks accumulate across repos/sessions. Any request marks activity; an in-flight request (the
// await-send long-poll especially) pins the desk alive, so only a desk nobody is connected to can
// idle out. The timer is unref'd and one-shot: it never keeps the process alive and never re-fires
// while shutdown runs.
export function createIdleWatchdog(
	idleMs: number,
	onIdle: () => void,
): IdleWatchdog {
	let lastActivity = Date.now()
	let activeRequests = 0
	let timer: NodeJS.Timeout | undefined
	const isIdle = (): boolean =>
		activeRequests === 0 && Date.now() - lastActivity >= idleMs
	if (idleMs > 0) {
		timer = setInterval(
			() => {
				if (isIdle()) {
					clearInterval(timer)
					onIdle()
				}
			},
			Math.min(
				IDLE_CHECK_MAX_MS,
				Math.max(idleMs / IDLE_CHECK_DIVISOR, IDLE_CHECK_MIN_MS),
			),
		)
		timer.unref()
	}
	return {
		requestStarted(): void {
			activeRequests++
			lastActivity = Date.now()
		},
		requestFinished(): void {
			activeRequests--
			lastActivity = Date.now()
		},
		stop(): void {
			if (timer) clearInterval(timer)
		},
	}
}

export function idleTimeoutOf(options: ServerOptions): number {
	return options.idleTimeoutMs ?? DEFAULT_IDLE_MS
}

// What a shutdown does when the caller did not supply a test seam: say why, then exit. The process
// exit handler removes the desk lock.
export function resolveShutdown(
	options: ServerOptions,
	session: string,
): (reason: 'idle' | 'stop') => void {
	if (options.onShutdown) return options.onShutdown
	return (reason: 'idle' | 'stop') => {
		warn(
			reason === 'idle'
				? `Desk idle - shutting down. Restart with: syneva --session ${session}`
				: 'Desk stopped via syneva stop.',
		)
		process.exit(0)
	}
}
