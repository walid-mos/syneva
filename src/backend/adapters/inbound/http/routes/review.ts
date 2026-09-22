import { appendLiveComment } from '../../../../application/add-comment.js'
import { browserState } from '../../../../application/browser-state.js'
import {
	resetReviewPatch,
	unstageReviewedFiles,
} from '../../../../application/reset-review.js'
import {
	applyReviewerSave,
	sendReview,
} from '../../../../application/send-review.js'
import { commentSide, parseLineNumber } from '../../../../domain/comments.js'
import {
	HTTP_OK,
	HTTP_UNPROCESSABLE,
	readJsonBody,
	json,
	fail,
} from '../http.js'
import { INVALID_SAVE, parseReviewerSave } from '../reviewer-save.js'

import type { BrowserResetResponse } from '../../../../../contracts/browser.js'
import type { CommentRequest } from '../../../../application/add-comment.js'
import type { RouteRequest } from '../router.js'

// Transport shape validation for the /api/comment body. A comment needs a file and a body;
// everything else has a documented default (additions, line 1, an agent-authored reply).
// lineNumber 0 is the whole-file anchor (see backend/domain/comments.ts) - a file comment has no
// diff side, so the side it may carry is normalized away. Returns null when the request lacks
// what it cannot default - the route answers 422 INVALID_COMMENT. Lives with the inbound route;
// the use case's CommentRequest input record stays in application.
function parseCommentRequest(payload: unknown): CommentRequest | null {
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
	const lineNumber = parseLineNumber(line)
	if (lineNumber === null) return null
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
		role: 'role' in payload && payload.role === 'user' ? 'user' : 'agent',
	}
}

// overallNote is an ephemeral, per-Send instruction threaded straight into the result -
// parseReviewerSave never copies it onto `state`, so it is never persisted.
function overallNoteOf(payload: unknown): string {
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!('overallNote' in payload)
	)
		return ''
	const note = payload.overallNote
	return typeof note === 'string' ? note.trim() : ''
}

export async function saveReview({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	// Merge only the reviewer-owned slice; the diff, file contents, changes, and desk metadata stay
	// authoritative here. The DTO decode shapes each record (and refuses a malformed patch with a
	// 422) before applyReviewerSave builds the next root from it - present keys replace, absent
	// keys are unchanged; the live root is never edited in place.
	await ctx.serialize(async (): Promise<void> => {
		const body: unknown = await readJsonBody(req)
		const patch = parseReviewerSave(body)
		if (patch === null) return fail(res, INVALID_SAVE)
		const saved = await ctx.persist(applyReviewerSave(ctx.state, patch))
		ctx.commit(saved.state)
		json(res, HTTP_OK, { ok: true, file: saved.file })
	})
}

export async function sendReviewToAgent({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	await ctx.serialize(async (): Promise<void> => {
		const body: unknown = await readJsonBody(req)
		const patch = parseReviewerSave(body)
		if (patch === null) return fail(res, INVALID_SAVE)
		const sent = await sendReview(
			ctx.state,
			{ git: ctx.git, store: ctx.store },
			{
				patch,
				overallNote: overallNoteOf(body),
			},
		)
		ctx.commit(sent.state)
		res.on('finish', () => {
			// The review supersedes any still-queued question (createEventStream drops them), so a
			// stale question can never land after the round. Emitting only once the response has
			// flushed keeps the reviewer's ack ahead of the agent's wake-up.
			ctx.events.emit({ kind: 'review', result: sent.reviewResult })
		})
		json(res, HTTP_OK, {
			ok: true,
			sent: true,
			resultJson: sent.resultJson,
		})
	})
}

export async function addComment({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	await ctx.serialize(async (): Promise<void> => {
		const body: unknown = await readJsonBody(req)
		const request = parseCommentRequest(body)
		if (!request)
			return fail(res, {
				status: HTTP_UNPROCESSABLE,
				code: 'INVALID_COMMENT',
				error: 'comment requires path and body',
				fix: 'Send { path, lineNumber, side, body } as JSON.',
			})
		const appended = await appendLiveComment(ctx.state, request, ctx.git)
		if (appended.comment.role === 'agent') ctx.activity.clear()
		const saved = await ctx.persist(appended.state)
		ctx.commit(saved.state)
		json(res, HTTP_OK, { ok: true, commentId: appended.comment.id })
	})
}

export async function resetDesk({ ctx, res }: RouteRequest): Promise<void> {
	await ctx.serialize(async (): Promise<void> => {
		await unstageReviewedFiles(ctx.state, ctx.git)
		const saved = await ctx.persist({
			...ctx.state,
			...resetReviewPatch(ctx.state),
		})
		ctx.commit(saved.state)
		const response: BrowserResetResponse = {
			ok: true,
			state: browserState(saved.state),
			serverInstanceId: ctx.instanceId,
		}
		json(res, HTTP_OK, response)
	})
}
