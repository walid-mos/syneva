import { listProjectTree } from '../../git/repo.js'
import { readGlobalSettings, writeGlobalSettings } from '../../state/desk.js'
import { readStagedSnapshot } from '../../state/reconcile.js'
import { readBody, json, HTTP_OK } from '../http.js'

import type { PollPayload } from '../../types.js'
import type { RouteRequest } from '../router.js'

export async function servePoll({ ctx, res }: RouteRequest): Promise<void> {
	// The tab's 1.5s heartbeat. Deliberately tiny and git-free: the full ReviewState carries the
	// contents of every file in the diff (>100 MB on a big monorepo PR), and re-serializing it every
	// tick pegged both the desk process and the tab. Ship only what pollState diffs - hash, guide,
	// comments, liveness; the tab fetches /api/state exactly once per baseDiffHash change.
	const poll: PollPayload = {
		baseDiffHash: ctx.state.baseDiffHash,
		guide: ctx.state.guide,
		comments: ctx.state.comments,
	}
	json(res, HTTP_OK, { ...poll, ...ctx.status() })
}

export async function serveState({ ctx, res }: RouteRequest): Promise<void> {
	Object.assign(ctx.state, await readStagedSnapshot(ctx.state))
	json(res, HTTP_OK, { ...ctx.state, ...ctx.status() })
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
