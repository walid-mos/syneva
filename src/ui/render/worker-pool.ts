import { S } from '../store'

import { TokenPoolManager } from './token-pool/manager'

import type { FileDiffMetadata } from '@pierre/diffs'
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
// /worker.js route). The grammar set is NOT in the worker bundle - the manager resolves a diff's
// grammar on the main thread (lazily, one chunk per language) and ships the resolved data to
// whichever workers run that file.

// Pool width trades throughput against memory: every worker holds its own compiled grammar plus
// token caches, which is why it is CAPPED rather than sized to the machine. One core is left to
// the main thread (merges, publishes and @pierre's layout all run there) and one to the OS.
//
// Measured on the 6-core bench machine (history.json, milestone "parallel"): the 5th worker cut the
// 16k-line fixture's token phase from 1614 ms to 1275 ms (-21%) while a normal file's open stayed
// inside run-to-run noise (first colour 713 vs 680 ms, final 1283 vs 1241 ms), because an extra
// worker pays one more grammar compile in the window it runs first. The cap is the memory budget:
// a 16-core desktop gets 6, not 14.
const POOL_MEMORY_CAP = 6
const MIN_POOL_SIZE = 2
const POOL_RESERVED_CORES = 1
// Fallback for a browser that hides the core count (or a privacy build rounding it down to 1).
const ASSUMED_CORES = 4
const WORKER_POOL_SIZE = Math.min(
	POOL_MEMORY_CAP,
	Math.max(
		MIN_POOL_SIZE,
		(navigator.hardwareConcurrency || ASSUMED_CORES) - POOL_RESERVED_CORES,
	),
)
// Same-origin path the built worker file is served at (routes.ts `GET /worker.js`). Module
// format: the esbuild bundle is ESM with no runtime imports. Exported for the prefetch's parse
// worker (render/parse-offload.ts), which loads the same script for a job the pool does not own.
export const WORKER_URL = '/worker.js'

let poolSingleton: TokenPoolManager | null = null
// Serialized token-relevant settings at last sync; '' means "never synced".
let lastSyncedOptions = ''

// One contained cast: @pierre's WorkerPoolManager type is nominal over private members, so an
// application-owned adapter can't `implements` it. The manager deliberately mirrors the
// duck-typed surface @pierre's renderers read (see render/token-pool/manager.ts); the cast
// exists only at this single exposure point, where the repo hands the pool to @pierre's
// constructor styled API.
export function diffWorkerPool(): WorkerPoolManager {
	return ensurePool() as unknown as WorkerPoolManager
}

// The render pass's own parse knows the file's grammar before the pool is asked for anything, and
// resolving it (chunk fetch + registration) is longer than the worker boot - so the pass starts it
// there and lets the two overlap (token-pool/job-board.ts prewarmLanguages).
export function prewarmPoolLanguages(diff: FileDiffMetadata): void {
	ensurePool().prewarmLanguages(diff)
}

// Warm the NEXT file's viewport band while the pool is otherwise idle, so the switch publishes colored
// rows from cache. render/prefetch.ts decides which file and when; the pool only decides whether its
// workers may spend idle time on it (window-dispatch.ts caps a prefetch to one band). A viewport seeds
// the primed job's plan (windows.ts is LPT-ordered without one): the cold-open overlay knows the head
// rows it paints before any renderer exists.
export function prefetchPoolDiff(
	diff: FileDiffMetadata,
	viewport?: { startingLine: number; totalLines: number },
): void {
	const pool = ensurePool()
	if (viewport && diff.cacheKey)
		pool.board.noteViewport(
			diff.cacheKey,
			viewport.startingLine,
			viewport.totalLines,
		)
	pool.prefetchDiff(diff)
}

// True while the pool still owes this diff its first coloured publish: the cold-open reveal holds
// the pane on this instead of flashing the plain rows an uncolored mount would paint.
export function awaitingPoolPublish(cacheKey: string | undefined): boolean {
	const pool = ensurePool()
	return (
		!!cacheKey &&
		pool.board.jobOpen(cacheKey) &&
		!pool.board.hasPublished(cacheKey)
	)
}

function ensurePool(): TokenPoolManager {
	poolSingleton ??= new TokenPoolManager({
		poolOptions: {
			workerFactory: () => new Worker(WORKER_URL, { type: 'module' }),
			poolSize: WORKER_POOL_SIZE,
		},
		highlighterOptions: {
			theme: { dark: S.settings.theme, light: S.settings.theme },
		},
	})
	return poolSingleton
}

// Boot the pool on idle, while the desk state is still in flight.
//
// The renderer cannot request tokens until the pool's boot settles, and the boot starts with the
// main-thread plain highlighter (measured 62-110 ms of engine + theme work, of which the chunk
// fetch is 5 ms) - so waiting for the first render pass to start it puts that whole cost between
// the reviewer and the first colored row. The scheduling lives in warm-pool-boot.ts: this entry is
// reached through the dynamic import there, which keeps the pool's graph out of the initial bundle.
export function warmPoolBoot(): void {
	ensurePool().warmBoot()
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
