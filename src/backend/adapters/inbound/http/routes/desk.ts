import { browserState } from '../../../../application/browser-state.js'
import { readJsonBody, json, jsonBody, HTTP_OK } from '../http.js'

import type {
	BrowserRefreshEvent,
	PollPayload,
} from '../../../../../contracts/browser.js'
import type { RouteRequest } from '../router.js'

export async function servePoll({
	ctx,
	res,
	url,
}: RouteRequest): Promise<void> {
	// A restarted desk may ship a different state contract. Tell an already-loaded tab to refresh
	// its bundle first; legacy clients without an instance token still receive the normal heartbeat.
	const { searchParams } = url
	const instance = searchParams.get('instance')
	if (instance && instance !== ctx.instanceId) {
		const event: BrowserRefreshEvent = { kind: 'refresh' }
		json(res, HTTP_OK, { ...event, ...ctx.status() })
		return
	}
	// Keep the 1.5s heartbeat tiny and git-free; file summaries and changes only ride /api/state.
	// One capture: the three review fields must come from one state root - a commit landing
	// mid-build would otherwise stitch the poll from two revisions.
	const { state } = ctx
	const poll: PollPayload = {
		baseDiffHash: state.baseDiffHash,
		guide: state.guide,
		comments: state.comments,
	}
	json(res, HTTP_OK, { ...poll, ...ctx.status() })
}

export async function serveState({ ctx, res }: RouteRequest): Promise<void> {
	await ctx.refreshStaged()
	// Revision first, then the root: a commit landing between the two reads can only park a
	// body under the OLDER revision (the next read's revision check rejects it) - never serve
	// a stale body under the newer one. The response is the browser projection plus the
	// transient desk status; only the projection is expensive to build, and only the status
	// can move between two reads of the same review, so the cached body keys on both.
	const status = ctx.status()
	const body = ctx.stateBodyCache.body(
		ctx.revision,
		JSON.stringify({ ...status, serverInstanceId: ctx.instanceId }),
		() =>
			JSON.stringify({
				...browserState(ctx.state),
				...status,
				serverInstanceId: ctx.instanceId,
			}),
	)
	jsonBody(res, HTTP_OK, body)
}

export async function serveTree({ ctx, res }: RouteRequest): Promise<void> {
	await ctx.refreshStaged()
	json(res, HTTP_OK, { files: await ctx.git.projectTree(ctx.state.root) })
}

// Display preferences, stored globally in ~/.syneva/settings.json - the desk's random port makes
// browser localStorage (per-origin) useless for them.
export async function serveSettings({ ctx, res }: RouteRequest): Promise<void> {
	json(res, HTTP_OK, await ctx.settings.read())
}

export async function saveSettings({
	ctx,
	req,
	res,
}: RouteRequest): Promise<void> {
	const settings: unknown = await readJsonBody(req)
	await ctx.settings.write(settings)
	json(res, HTTP_OK, { ok: true })
}
