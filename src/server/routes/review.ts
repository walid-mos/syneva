import { reviewerSavePatch } from '../../state/persistence.js'
import { appendLiveComment, parseCommentRequest } from '../add-comment.js'
import { browserState } from '../browser-state.js'
import { HTTP_OK, HTTP_UNPROCESSABLE, readBody, json, fail } from '../http.js'
import { resetReviewPatch, unstageReviewedFiles } from '../reset-review.js'
import { sendReview } from '../send-review.js'

import type { BrowserResetResponse } from '../../types.js'
import type { RouteRequest } from '../router.js'

export async function saveReview({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	// Merge only the reviewer-owned slice; the diff, file contents, changes, and desk metadata stay
	// authoritative here. Pick from whatever body arrives so a stale open tab still posting the old
	// full-state body keeps working (extra fields ignored).
	await ctx.serialize(async (): Promise<void> => {
		const body: unknown = JSON.parse(await readBody(req))
		Object.assign(ctx.state, reviewerSavePatch(body))
		const file = await ctx.persist()
		json(res, HTTP_OK, { ok: true, file })
	})
}

export async function sendReviewToAgent({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	await ctx.serialize(async (): Promise<void> => {
		const body: unknown = JSON.parse(await readBody(req))
		const sent = await sendReview(
			ctx.state,
			(): Promise<string> => ctx.persist(),
			body,
		)
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
		const body: unknown = JSON.parse(await readBody(req))
		const request = parseCommentRequest(body)
		if (!request)
			return fail(res, {
				status: HTTP_UNPROCESSABLE,
				code: 'INVALID_COMMENT',
				error: 'comment requires path and body',
				fix: 'Send { path, lineNumber, side, body } as JSON.',
			})
		const comment = await appendLiveComment(ctx.state, request)
		if (comment.role === 'agent') ctx.activity.clear()
		await ctx.persist()
		json(res, HTTP_OK, { ok: true, commentId: comment.id })
	})
}

export async function resetDesk({ ctx, res }: RouteRequest): Promise<void> {
	await ctx.serialize(async (): Promise<void> => {
		await unstageReviewedFiles(ctx.state)
		Object.assign(ctx.state, resetReviewPatch(ctx.state))
		await ctx.persist()
		const response: BrowserResetResponse = {
			ok: true,
			state: browserState(ctx.state),
			serverInstanceId: ctx.instanceId,
		}
		json(res, HTTP_OK, response)
	})
}
