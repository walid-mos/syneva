import { listProjectTree } from '../../git/repo.js'
import { readGlobalSettings, writeGlobalSettings } from '../../state/desk.js'
import { readStagedSnapshot } from '../../state/reconcile.js'
import { browserState } from '../browser-state.js'
import { readBody, json, HTTP_OK } from '../http.js'

import type { BrowserRefreshEvent, PollPayload } from '../../types.js'
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
	Object.assign(ctx.state, await readStagedSnapshot(ctx.state))
	json(res, HTTP_OK, {
		...browserState(ctx.state),
		...ctx.status(),
		serverInstanceId: ctx.instanceId,
	})
}

export async function serveTree({ ctx, res }: RouteRequest): Promise<void> {
	Object.assign(ctx.state, await readStagedSnapshot(ctx.state))
	json(res, HTTP_OK, { files: await listProjectTree(ctx.state.root) })
}

// Display preferences, stored globally in ~/.galley/settings.json - the desk's random port makes
// browser localStorage (per-origin) useless for them.
export async function serveSettings({ res }: RouteRequest): Promise<void> {
	json(res, HTTP_OK, await readGlobalSettings())
}

export async function saveSettings({ req, res }: RouteRequest): Promise<void> {
	const settings: unknown = JSON.parse(await readBody(req))
	await writeGlobalSettings(settings)
	json(res, HTTP_OK, { ok: true })
}
