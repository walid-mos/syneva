import { HTTP_CONFLICT, HTTP_OK, readBody, json, fail } from '../http.js'
import { stageChange, stagePaths, unstagePath } from '../staging.js'

import type { ApiFailure } from '../failure.js'
import type { RouteRequest } from '../router.js'
import type { StageChangeRequest, StagePathsRequest } from '../staging.js'

// PR changes are committed; accept/reject are approve/request-changes verdicts, so there is nothing
// to stage. Both staging routes refuse identically.
const STAGING_DISABLED: ApiFailure = {
	status: HTTP_CONFLICT,
	code: 'STAGING_DISABLED',
	error: 'Staging is unavailable in PR review mode.',
	fix: 'PR changes are committed; accept/reject are approve/request-changes verdicts.',
}

export async function stageFiles({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	if (ctx.state.mode === 'pr') return fail(res, STAGING_DISABLED)
	await ctx.serialize(async (): Promise<void> => {
		const body: unknown = JSON.parse(await readBody(req))
		Object.assign(
			ctx.state,
			await stagePaths(ctx.state, parseStagePathsRequest(body)),
		)
		await ctx.persist()
		json(res, HTTP_OK, { ok: true })
	})
}

export async function stageOneChange({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	if (ctx.state.mode === 'pr') return fail(res, STAGING_DISABLED)
	await ctx.serialize(async (): Promise<void> => {
		const body: unknown = JSON.parse(await readBody(req))
		const outcome = await stageChange(
			ctx.state,
			parseStageChangeRequest(body),
		)
		if (outcome.decision === 'conflict')
			return fail(res, {
				status: HTTP_CONFLICT,
				code: 'PATCH_CONFLICT',
				error: outcome.message,
				fix: 'The working tree changed since the desk loaded. Reload it (GET /api/state) and retry.',
			})
		if (outcome.decision === 'staged') {
			Object.assign(ctx.state, {
				stagedChangeKeys: outcome.stagedChangeKeys,
			})
			await ctx.persist()
		}
		json(res, HTTP_OK, { ok: true, skipped: outcome.skipped })
	})
}

export async function unstageFile({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	await ctx.serialize(async (): Promise<void> => {
		const body: unknown = JSON.parse(await readBody(req))
		Object.assign(
			ctx.state,
			await unstagePath(ctx.state, parseUnstageRequest(body)),
		)
		await ctx.persist()
		json(res, HTTP_OK, { ok: true })
	})
}

// `{ path }` (back-compat) or `{ paths }` (a move pair in one `git add`). The recorded review path is
// the explicit `path`, else the last of `paths` - approveCurrentFile sends [old, new], so the entry
// that survives the rename is the one recorded.
function parseStagePathsRequest(payload: unknown): StagePathsRequest {
	if (typeof payload !== 'object' || payload === null) return { paths: [] }
	const single =
		'path' in payload && typeof payload.path === 'string'
			? payload.path
			: undefined
	const postedPaths: unknown[] | undefined =
		'paths' in payload && Array.isArray(payload.paths)
			? payload.paths
			: undefined
	const posted = postedPaths?.filter(
		candidate => typeof candidate === 'string',
	)
	const paths = posted ?? (single ? [single] : [])
	return { paths, recorded: single ?? paths.at(-1) }
}

function parseStageChangeRequest(payload: unknown): StageChangeRequest {
	if (typeof payload !== 'object' || payload === null)
		return { path: '', stableKey: '' }
	return {
		path:
			'path' in payload && typeof payload.path === 'string'
				? payload.path
				: '',
		stableKey:
			'stableKey' in payload && typeof payload.stableKey === 'string'
				? payload.stableKey
				: '',
	}
}

function parseUnstageRequest(payload: unknown): string {
	if (typeof payload !== 'object' || payload === null) return ''
	return 'path' in payload && typeof payload.path === 'string'
		? payload.path
		: ''
}
