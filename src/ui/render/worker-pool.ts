import { S } from '../store'

import { TokenPoolManager } from './token-pool/manager'

import type { WorkerPoolManager } from '@pierre/diffs/worker'

// The token pool: Shiki tokenization/highlighting runs in Web Workers on windowed slices of each
// diff (render/token-pool/manager.ts) instead of one whole-file task, so a 16k-line sparse file
// streams colored rows in ~1 s instead of paying a ~53 s single task. The manager owns a main
// plain skeleton per file and merges worker windows into it progressively.
//
// Token-relevant settings (theme, per-line diff) must reach the POOL - syncPoolRenderOptions()
// at every render pass - or cached token grids go stale for the current settings (the manager
// invalidates its job state and re-adopts on drift). The worker script is dist/worker.js,
// built and served by the desk (scripts/build-ui.mjs entry → src/ui/worker/diff-token-worker.ts,
// /worker.js route). 4 workers keep the pool under the UI's memory budget; every worker embeds
// the curated grammar set through the shiki shim (no oniguruma build wired either side).

const WORKER_POOL_SIZE = 4
// Same-origin path the built worker file is served at (routes.ts `GET /worker.js`). Module
// format: the esbuild bundle is ESM with no runtime imports.
const WORKER_URL = '/worker.js'

let poolSingleton: TokenPoolManager | null = null
// Serialized token-relevant settings at last sync; '' means "never synced".
let lastSyncedOptions = ''

// One contained cast: @pierre's WorkerPoolManager type is nominal over private members, so an
// application-owned adapter can't `implements` it. The manager deliberately mirrors the
// duck-typed surface @pierre's renderers read (see render/token-pool/manager.ts); the cast
// exists only at this single exposure point, where the repo hands the pool to @pierre's
// constructor styled API.
export function diffWorkerPool(): WorkerPoolManager {
	poolSingleton ??= new TokenPoolManager({
		poolOptions: {
			workerFactory: () => new Worker(WORKER_URL, { type: 'module' }),
			poolSize: WORKER_POOL_SIZE,
		},
		highlighterOptions: {
			theme: { dark: S.settings.theme, light: S.settings.theme },
		},
	})
	return poolSingleton as unknown as WorkerPoolManager
}

// Keep the pool's token settings equal to the current settings, installing on drift. Cheap to
// call per render: the common case is one string compare. Drift invalidates the pool's caches
// and adopts on workers file-keepers - results published before adoption get dropped when their
// job no longer exists, which is exactly the rollback the new settings need.
export function syncPoolRenderOptions(): void {
	const signature = JSON.stringify([
		S.settings.theme,
		S.settings.lineDiffType,
	])
	if (signature === lastSyncedOptions) return
	lastSyncedOptions = signature
	// Fire-and-forget: adoption broadcasts to subscribers (~pierre's onThemeChange path) once
	// the workers have settled.
	void diffWorkerPool().setRenderOptions({
		theme: { dark: S.settings.theme, light: S.settings.theme },
		lineDiffType: S.settings.lineDiffType,
	})
}
