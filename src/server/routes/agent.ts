import { commentSide } from '../../state/comments.js'
import { questionPayload } from '../../state/review-result.js'
import {
	HTTP_NO_CONTENT,
	HTTP_OK,
	HTTP_UNPROCESSABLE,
	readBody,
	json,
	fail,
} from '../http.js'

import type { AwaitEvent } from '../../types.js'
import type { RouteRequest } from '../router.js'

const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const MS_PER_SECOND = 1000

// A long-poll with no --timeout holds for the reviewer's whole round; a harness that wants a
// bounded wait passes ?timeout=<seconds>.
const HOLD_DEFAULT_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND

// How long the desk lingers after ACKing a stop so the new `closed` event reaches a parked
// waiter (its HTTP response flushes on the emission, but Node needs a beat to write it to the
// socket before the process exits). Loopback: a fraction of a second is generous.
const CLOSED_EVENT_GRACE_MS = 150

export async function askQuestion({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	// Reviewer clicked Ask: push a question to the agent now, out of band from Send.
	const body: unknown = JSON.parse(await readBody(req))
	const request = parseAskRequest(body)
	if (!request)
		return fail(res, {
			status: HTTP_UNPROCESSABLE,
			code: 'INVALID_QUESTION',
			error: 'ask requires path and body',
			fix: 'Send { path, lineNumber, side, body } as JSON.',
		})
	// Bake the singular into a one-element `questions` here so a question handed straight to a parked
	// waiter already carries the array - batching only has to merge on drain.
	const question = questionPayload(ctx.state, request)
	ctx.events.emit({ kind: 'question', question, questions: [question] })
	json(res, HTTP_OK, { ok: true })
}

export async function awaitEvent({
	ctx,
	req,
	res,
	url,
}: RouteRequest): Promise<void> {
	// Long-poll the tagged event stream: resolves with the next queued event
	// ({kind:"question"|"review"}), letting the agent learn of questions and Sends without the desk
	// process exiting. createEventStream owns the queue's batching/flush rules.
	const queued = ctx.events.takeNext()
	if (queued) return json(res, HTTP_OK, queued)
	let isSettled = false
	const unpark = ctx.events.park((event: AwaitEvent): void => {
		if (isSettled) return
		isSettled = true
		clearTimeout(timer)
		json(res, HTTP_OK, event)
	})
	const timer = setTimeout((): void => {
		if (isSettled) return
		isSettled = true
		unpark()
		res.writeHead(HTTP_NO_CONTENT)
		res.end()
	}, holdMs(url))
	// A caller that hangs up (ctrl-C on `syneva await`) unparks its waiter: the event must stay
	// queued for the next await rather than vanish into a dead socket.
	req.on('close', (): void => {
		if (isSettled) return
		isSettled = true
		clearTimeout(timer)
		unpark()
	})
}

export async function postStatus({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	// Ephemeral agent activity (`syneva status`): a one-line "what I'm doing now" while the agent
	// works on a question or review. Never persisted.
	const body: unknown = JSON.parse(await readBody(req))
	const text = parseStatusRequest(body)
	if (!text)
		return fail(res, {
			status: HTTP_UNPROCESSABLE,
			code: 'INVALID_STATUS',
			error: 'status requires a non-empty body',
			fix: 'Send { body: "what you are doing" } as JSON.',
		})
	ctx.activity.set(text)
	json(res, HTTP_OK, { ok: true })
}

export async function stopDesk({ ctx, res }: RouteRequest): Promise<void> {
	// `syneva stop`, or the browser's Close action: exit after the response flushes, but first
	// tell any parked waiter WHY the desk is going (a `closed` event) so an agent's loop learns
	// the human ended the review instead of watching the socket die. The process exit handler
	// removes the desk lock.
	res.on('finish', () => {
		ctx.events.emit({ kind: 'closed', session: ctx.state.session })
		setTimeout(() => ctx.shutdown('stop'), CLOSED_EVENT_GRACE_MS)
	})
	json(res, HTTP_OK, { ok: true, stopping: true })
}

function parseAskRequest(payload: unknown): {
	path: string
	lineNumber: number
	side: 'additions' | 'deletions'
	body: string
} | null {
	if (typeof payload !== 'object' || payload === null) return null
	const filePath =
		'path' in payload && typeof payload.path === 'string'
			? payload.path
			: ''
	const text =
		'body' in payload && typeof payload.body === 'string'
			? payload.body.trim()
			: ''
	if (!filePath || !text) return null
	const line = 'lineNumber' in payload ? payload.lineNumber : undefined
	const lineNumber = Number(line ?? 1)
	return {
		path: filePath,
		lineNumber,
		side: commentSide(
			'side' in payload && payload.side === 'deletions'
				? 'deletions'
				: 'additions',
			lineNumber,
		),
		body: text,
	}
}

function parseStatusRequest(payload: unknown): string {
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!('body' in payload) ||
		typeof payload.body !== 'string'
	)
		return ''
	return payload.body.trim()
}

function holdMs(url: URL): number {
	const timeoutSec = Number(url.searchParams.get('timeout'))
	if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return HOLD_DEFAULT_MS
	return timeoutSec * MS_PER_SECOND
}
