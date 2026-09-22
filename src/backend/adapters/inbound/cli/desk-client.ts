import http from 'node:http'

import { API_PATHS } from '../../../../contracts/routes.js'

import type { Guide } from '../../../../contracts/review.js'

// The CLI's HTTP client to a live desk. Everything the agent subcommands send or receive
// goes through here so the wire shapes (comment id, reload result, await event) are read
// in one place instead of via `any` casts at each call site.

const DESK_ALIVE_TIMEOUT_MS = 1500
const SHUTDOWN_TIMEOUT_MS = 1500

// A desk lock URL ends in `/`; the API paths start with one, so base + path joins exactly.
function endpoint(base: string, path: string): string {
	return `${base}${path.slice(1)}`
}

export type DeskJsonResponse = { status: number; body: unknown }
export type DeskPostResult = { ok: boolean; body: unknown }
export type ReloadResult = { baseDiffHash?: string; empty?: boolean }

type JsonPost = {
	url: string
	payload?: unknown
	timeoutMs?: number
}

// A desk lock can outlive its process (crash, SIGKILL) - trust it only if the
// server actually answers.
export async function deskAlive(url: string): Promise<boolean> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), DESK_ALIVE_TIMEOUT_MS)
	try {
		const res = await fetch(endpoint(url, API_PATHS.state), {
			signal: ctrl.signal,
		})
		return res.ok
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}

export async function postJson({
	url,
	payload,
	timeoutMs,
}: JsonPost): Promise<DeskPostResult> {
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
		})
		if (!res.ok) return { ok: false, body: null }
		return { ok: true, body: await res.json() }
	} catch {
		return { ok: false, body: null }
	}
}

export function postShutdown(url: string): Promise<DeskPostResult> {
	return postJson({
		url: endpoint(url, API_PATHS.shutdown),
		timeoutMs: SHUTDOWN_TIMEOUT_MS,
	})
}

// Re-diff into the open desk, optionally swapping the attached guide in
// the same round-trip. The body is always an object so an absent guide posts `{}` (re-diff
// only) rather than an empty body the server would have to special-case.
export function postReload(
	deskUrl: string,
	guide: Guide | undefined,
): Promise<DeskPostResult> {
	return postJson({
		url: endpoint(deskUrl, API_PATHS.reload),
		payload: { ...guideSwap(guide) },
	})
}

function guideSwap(guide: Guide | undefined): { guide: Guide } | undefined {
	if (!guide) return undefined
	return { guide }
}

// GET with no client-side timeout, so a long-poll holds until the server
// responds. Avoids undici's ~5min headersTimeout that fetch() imposes.
export function httpGetJson(url: string): Promise<DeskJsonResponse> {
	return new Promise(resolve => {
		const req = http.get(url, res => {
			const chunks: Buffer[] = []
			res.on('data', chunk => chunks.push(Buffer.from(chunk)))
			res.on('end', () => {
				resolve(
					readJsonResponse(
						res.statusCode ?? 0,
						Buffer.concat(chunks).toString('utf8'),
					),
				)
			})
		})
		req.on('error', () => resolve({ status: 0, body: null }))
		req.setTimeout(0) // hold indefinitely for the long-poll
	})
}

function readJsonResponse(status: number, text: string): DeskJsonResponse {
	if (!text) return { status, body: null }
	try {
		return { status, body: JSON.parse(text) }
	} catch {
		return { status, body: null }
	}
}

export function readCommentId(body: unknown): string | undefined {
	if (typeof body !== 'object' || body === null) return undefined
	if (!('commentId' in body) || typeof body.commentId !== 'string')
		return undefined
	return body.commentId
}

export function readReloadResult(body: unknown): ReloadResult {
	const outcome: ReloadResult = {}
	if (typeof body !== 'object' || body === null) return outcome
	if ('baseDiffHash' in body && typeof body.baseDiffHash === 'string')
		outcome.baseDiffHash = body.baseDiffHash
	if ('empty' in body && typeof body.empty === 'boolean')
		outcome.empty = body.empty
	return outcome
}
