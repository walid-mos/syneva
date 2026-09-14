import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker'

import { S } from '../store'

import type { WorkerPoolManager } from '@pierre/diffs/worker'

// The @pierre/diffs worker pool: Shiki tokenization/highlighting runs in Web Workers instead of on
// the main thread, so a yarn-starved tab never freezes on a file switch. The manager itself is a
// LRU across files (keyed by @pierre cacheKey - ours: the file's contentHash), surviving beyond
// the 30-entry instance cache.
//
// The pool owns its own render settings (baked into every token it returns); FileDiff's
// per-instance options decide only chrome. Any token-relevant setting (theme, per-line diff) must
// be pushed to the POOL - syncPoolRenderOptions() at every render pass - or cached token batches
// go stale for the current settings. The worker script is dist/worker.js, built and served by the
// desk (scripts/build-ui.mjs, /worker.js route).

// 4 workers tokenize a big-diff review without racing the UI's memory budget (8 = @pierre's
// default; every worker embeds the curated grammar set).
const WORKER_POOL_SIZE = 4
// Same-origin path the built worker file is served at (routes.ts `GET /worker.js`). Module format:
// the esbuild bundle is ESM with no runtime imports.
const WORKER_URL = '/worker.js'

let poolSingleton: WorkerPoolManager | null = null
// Serialized token-relevant settings at last sync; '' means "never synced".
let lastSyncedOptions = ''

export function diffWorkerPool(): WorkerPoolManager {
	poolSingleton ??= getOrCreateWorkerPoolSingleton({
		poolOptions: {
			workerFactory: () => new Worker(WORKER_URL, { type: 'module' }),
			poolSize: WORKER_POOL_SIZE,
		},
		highlighterOptions: {
			// Languages attach lazily per task (the manager resolves from the shared highlighter's
			// bundle - Galley's curated registry via shiki-shim.ts). Pin the JS regex engine: galley
			// never uses oniguruma wasm (build-ui.mjs stubs it out of the worker bundle).
			langs: [],
			theme: { dark: S.settings.theme, light: S.settings.theme },
			preferredHighlighter: 'shiki-js',
		},
	})
	return poolSingleton
}

// Keep the pool's token settings equal to the current settings, installing on drift. Cheap to call
// per render: the common case is one string compare. Drift triggers a pool-wide re-highlight (the
// manager bumps its cache version), so file renders started before the answer must not block on it
// - the pool re-renders instances on completion.
export function syncPoolRenderOptions(): void {
	const signature = JSON.stringify([
		S.settings.theme,
		S.settings.lineDiffType,
	])
	if (signature === lastSyncedOptions) return
	lastSyncedOptions = signature
	// Fire-and-forget: the pool broadcasts to its instances when the workers have adopted it.
	void diffWorkerPool().setRenderOptions({
		theme: { dark: S.settings.theme, light: S.settings.theme },
		lineDiffType: S.settings.lineDiffType,
	})
}
