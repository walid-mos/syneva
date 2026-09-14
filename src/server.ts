import http from 'node:http'
import os from 'node:os'

import { createActivity } from './server/activity.js'
import { resolveBinding } from './server/binding.js'
import { createDeskContext } from './server/context.js'
import { createEventStream } from './server/events.js'
import { listenOn, openBrowser } from './server/listen.js'
import { DEFAULT_HOST } from './server/options.js'
import { createRequestHandler } from './server/router.js'
import { routes } from './server/routes.js'
import {
	createIdleWatchdog,
	idleTimeoutOf,
	resolveShutdown,
} from './server/shutdown.js'

import type { ServerHandle, ServerOptions } from './server/options.js'

// Test seam: TTL for the ephemeral agent-activity line (default 90s).
const DEFAULT_STATUS_TTL_MS = 90_000

// Start the desk: bind it, wire its collaborators, and hand back the two URLs the caller prints
// (one for the reviewer's browser, one for the same-machine agent CLI). The route table, the origin
// guard, the mutation mutex, and the idle watchdog all live behind this call.
export async function startServer(
	options: ServerOptions,
): Promise<ServerHandle> {
	const { state } = options
	const host = options.host ?? DEFAULT_HOST
	const binding = resolveBinding(
		host,
		os.hostname(),
		options.allowedHosts ?? [],
	)
	const shutdown = resolveShutdown(options, state.session)
	const events = createEventStream()
	const activity = createActivity(
		options.statusTtlMs ?? DEFAULT_STATUS_TTL_MS,
	)
	const watchdog = createIdleWatchdog(idleTimeoutOf(options), () =>
		shutdown('idle'),
	)
	const ctx = createDeskContext(state, options, {
		binding,
		events,
		activity,
		watchdog,
		shutdown,
	})
	const server: http.Server = http.createServer(
		createRequestHandler(ctx, routes, (): number => portOf(server)),
	)
	await listenOn(server, options.port ?? 0, host)
	server.on('close', () => watchdog.stop())
	const port = portOf(server)
	const url = `http://${binding.browserHost}:${port}/`
	const lockUrl = `http://${binding.lockHost}:${port}/`
	if (options.open !== false) await openBrowser(url)
	return { server, url, lockUrl }
}

// The listening port. server.address() is only populated once the socket is bound, and the origin
// guard re-reads it per request, so it must stay a lookup rather than a captured value.
function portOf(server: http.Server): number {
	const address = server.address()
	return typeof address === 'object' && address ? address.port : 0
}
