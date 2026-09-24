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
import {
	HTTP_OK,
	HTTP_UNPROCESSABLE,
	readJsonBody,
	json,
	fail,
} from '../http.js'
import { INVALID_SAVE, parseReviewerSave } from '../reviewer-save.js'

import { parseCommentRequest } from './comment-body.js'

import type { BrowserResetResponse } from '../../../../../contracts/browser.js'
import type { ResetScope } from '../../../../../contracts/review.js'
import type { RouteRequest } from '../router.js'

// The reset body's scope: absent/empty -> 'all' (the documented pre-scope behavior); a
// recognized value passes; anything else parsed -> null, which the route rejects.
function parseResetScope(body: unknown): ResetScope | null {
	if (typeof body !== 'object' || body === null) return 'all'
	if (!('scope' in body)) return 'all'
	if (typeof body.scope !== 'string') return null
	if (body.scope === 'review' || body.scope === 'approved') return body.scope
	if (body.scope === 'all') return 'all'
	return null
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

export async function resetDesk({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	await ctx.serialize(async (): Promise<void> => {
		// Bodyless POST = the documented 'all'. Malformed JSON means the same default; a parsed
		// body with an unknown scope is rejected - the caller must name what it wants dropped.
		let body: unknown
		try {
			body = await readJsonBody(req)
		} catch {
			body = undefined
		}
		const scope = parseResetScope(body)
		if (scope === null)
			return fail(res, {
				status: HTTP_UNPROCESSABLE,
				code: 'INVALID_RESET_SCOPE',
				error: 'scope must be "review", "approved" or "all"',
				fix: 'Send { "scope": "review" } - review keeps the notes, all clears them.',
			})
		// 'approved' restores only the signed-off files to the working diff; the other scopes
		// drop every decision, so the whole review unstages.
		const unstagePaths =
			scope === 'approved' ? [...ctx.state.reviewedFiles] : undefined
		await unstageReviewedFiles(ctx.state, ctx.git, unstagePaths)
		const saved = await ctx.persist({
			...ctx.state,
			...resetReviewPatch(ctx.state, scope),
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
