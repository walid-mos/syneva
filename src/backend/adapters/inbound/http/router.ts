import { STATIC_PATHS } from '../../../../contracts/routes.js'
import { errorMessage } from '../../../application/errors.js'

import { originAllowed } from './binding.js'
import { DOCS } from './failure.js'
import {
	HTTP_BAD_REQUEST,
	HTTP_INTERNAL,
	HTTP_NOT_FOUND,
	BodyDecodeError,
	fail,
} from './http.js'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DeskContext } from './context.js'

// A route's whole world: the desk it belongs to, the request it answers, and the response it
// writes. Handlers end the response themselves - some stream (the await-send long-poll), some
// attach a post-flush hook (Send, shutdown), so the dispatcher never writes on their behalf.
export type RouteRequest = {
	ctx: DeskContext
	req: IncomingMessage
	res: ServerResponse
	url: URL
}

export type RouteHandler = (request: RouteRequest) => Promise<void>

// Keyed `METHOD /path` - the desk's one route registry. Values admit undefined because a lookup for
// any other method/path misses, which is the dispatcher's 404.
export type RouteTable = Readonly<Record<string, RouteHandler | undefined>>

// The desk's request entry point: liveness bookkeeping, the origin guard for every route
// (current and future), the route lookup, and the one place an unexpected throw becomes a 500.
export function createRequestHandler(
	ctx: DeskContext,
	routes: RouteTable,
	listenPort: () => number,
): (req: IncomingMessage, res: ServerResponse) => void {
	async function handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			// The desk answers only its own origin. server.address() is populated by the
			// time requests arrive.
			if (
				!originAllowed(req, res, listenPort(), ctx.binding.allowedHosts)
			)
				return
			const url = new URL(req.url ?? '/', 'http://127.0.0.1')
			const route =
				routes[`${req.method ?? ''} ${url.pathname}`] ??
				(url.pathname.startsWith(STATIC_PATHS.chunksPrefix)
					? routes[
							`${req.method ?? ''} ${STATIC_PATHS.chunksPrefix}*`
						]
					: undefined)
			if (route) return await route({ ctx, req, res, url })
			fail(res, {
				status: HTTP_NOT_FOUND,
				code: 'NOT_FOUND',
				error: 'Not found',
				fix: `See ${DOCS} for the route list.`,
			})
		} catch (error) {
			reportFailure(res, error)
		}
	}
	return (req: IncomingMessage, res: ServerResponse): void => {
		ctx.watchdog.requestStarted()
		res.on('close', () => ctx.watchdog.requestFinished())
		void handleRequest(req, res)
	}
}

// The one place an unexpected throw becomes a response: a BodyDecodeError is the caller's
// bug (a malformed/oversized body) and answers 400; anything else is an INTERNAL 500.
function reportFailure(res: ServerResponse, error: unknown): void {
	if (error instanceof BodyDecodeError) {
		fail(res, {
			status: HTTP_BAD_REQUEST,
			code: 'INVALID_JSON',
			error: errorMessage(error),
			fix: `Send a JSON body of the documented shape. See ${DOCS} for the routes.`,
		})
		return
	}
	fail(res, {
		status: HTTP_INTERNAL,
		code: 'INTERNAL',
		error: errorMessage(error),
		fix: 'Unexpected server error; retry once, then reload the desk.',
	})
}
