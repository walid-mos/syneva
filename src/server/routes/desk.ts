import { listProjectTree } from '../../git/repo.js'
import { readGlobalSettings, writeGlobalSettings } from '../../state/desk.js'
import { readStagedSnapshot } from '../../state/reconcile.js'
import { browserState } from '../browser-state.js'
import { readBody, json, jsonBody, HTTP_OK } from '../http.js'

import type { BrowserRefreshEvent, PollPayload } from '../../types.js'
import type { DeskContext } from '../context.js'
import type { RouteRequest } from '../router.js'

export async function servePoll({
	ctx,
	res,
	url,
}: RouteRequest): Promise<void> {
	// A restarted desk may ship a different state contract. Tell an already-loaded tab to refresh
	// its bundle first; legacy clients without an instance token still receive the normal heartbeat.
	const instance = url.searchParams.get('instance')
	if (instance && instance !== ctx.instanceId) {
		const event: BrowserRefreshEvent = { kind: 'refresh' }
		json(res, HTTP_OK, { ...event, ...ctx.status() })
		return
	}
	// Keep the 1.5s heartbeat tiny and git-free; file summaries and changes only ride /api/state.
	const poll: PollPayload = {
		baseDiffHash: ctx.state.baseDiffHash,
		guide: ctx.state.guide,
		comments: ctx.state.comments,
	}
	json(res, HTTP_OK, { ...poll, ...ctx.status() })
}

export async function serveState({ ctx, res }: RouteRequest): Promise<void> {
	await refreshStagedState(ctx)
	// The response is the browser projection plus the transient desk status. Only the projection is
	// expensive to build, and only the status can move between two reads of the same review, so key
	// the cached body on both: the cache's own revision covers the review, this key the process.
	const status = ctx.status()
	const body = ctx.stateBodyCache.body(
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
	await refreshStagedState(ctx)
	json(res, HTTP_OK, { files: await listProjectTree(ctx.state.root) })
}

// Reflect the live git index onto the review before serving it: an external `git add` must show up
// without a reload, so the snapshot is read from git on every request. A snapshot that did not move
// must not invalidate the cached body though, or every tab poll would re-render the review.
async function refreshStagedState(ctx: DeskContext): Promise<void> {
	const snapshot = await readStagedSnapshot(ctx.state)
	const moved =
		!samePaths(ctx.state.stagedFiles, snapshot.stagedFiles) ||
		!samePaths(ctx.state.stagedChangeKeys ?? [], snapshot.stagedChangeKeys)
	Object.assign(ctx.state, snapshot)
	if (moved) ctx.stateBodyCache.invalidate()
}

// Both arrays come from the same git output in the same order on every read, so a positional
// compare is exact - and unlike a set compare it would still catch a genuine reorder.
function samePaths(current: string[], next: string[]): boolean {
	return (
		current.length === next.length &&
		current.every((path, index) => path === next[index])
	)
}

// Display preferences, stored globally in ~/.syneva/settings.json - the desk's random port makes
// browser localStorage (per-origin) useless for them.
export async function serveSettings({ res }: RouteRequest): Promise<void> {
	json(res, HTTP_OK, await readGlobalSettings())
}

export async function saveSettings({ req, res }: RouteRequest): Promise<void> {
	const settings: unknown = JSON.parse(await readBody(req))
	await writeGlobalSettings(settings)
	json(res, HTTP_OK, { ok: true })
}
