import { S } from '../store'

import { DEFAULT_TOKEN_OPTIONS } from './token-pool/plain'
import { TokenPool, WORKER_POOL_SIZE } from './token-pool/pool'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { WorkerPoolManager } from '@pierre/diffs/worker'
import type { ParseInput } from './parse-input'
import type { WindowViewport } from './token-pool/windows'

// The token pool: Shiki tokenization/highlighting runs in Web Workers on windowed slices of each
// diff (render/token-pool/pool.ts) instead of one whole-file task, so a 16k-line sparse file
// streams colored rows in ~1 s instead of paying a ~53 s single task. The pool owns the plain
// base, the merge grid and the publishes; the mount (placeholder.ts) holds on `openPoolJob`
// until the visible band has merged, so a cold open paints token rows from the first frame.
//
// Token-relevant settings (theme, per-line diff) must reach the POOL - syncPoolRenderOptions()
// at every render pass - or cached token grids go stale for the current settings (the pool
// invalidates its job state and re-adopts on drift). The worker script is dist/worker.js, built
// and served by the desk (scripts/build-ui.mjs entry → src/ui/worker/diff-token-worker.ts,
// /worker.js route). The grammar set is NOT in the worker bundle - the pool resolves a diff's
// grammars on the main thread (lazily, one chunk per language) and ships the resolved data to
// whichever workers run that file.
//
// Slot sizing (pool.ts WORKER_POOL_SIZE) is the memory budget, not the core count: one core is
// left to the main thread (merges, publishes and @pierre's layout all run there) and one to the
// OS. Measured on the 6-core bench machine (history.json, milestone "parallel"): the 5th worker
// cut the 16k-line fixture's token phase from 1614 ms to 1275 ms (-21%) while a normal file's
// open stayed inside run-to-run noise.
export const WORKER_URL = '/worker.js'

let poolSingleton: TokenPool | null = null
// Serialized token-relevant settings at last sync; '' means "never synced".
let lastSyncedOptions = ''

function ensurePool(): TokenPool {
	poolSingleton ??= new TokenPool(
		() => new Worker(WORKER_URL, { type: 'module' }),
		WORKER_POOL_SIZE,
		// The desk's settings at first touch: the pool's idle boot must not tokenize a frame
		// under the default theme only to re-adopt the real one on the first render pass.
		{
			...DEFAULT_TOKEN_OPTIONS,
			theme: { dark: S.settings.theme, light: S.settings.theme },
			lineDiffType: S.settings.lineDiffType,
		},
	)
	return poolSingleton
}

// One contained cast: @pierre's WorkerPoolManager type is nominal over private members, so an
// application-owned adapter can't `implements` it. The pool deliberately mirrors the duck-typed
// surface @pierre's renderers read (see render/token-pool/pool.ts); the cast exists only at this
// single exposure point, where the repo hands the pool to @pierre's constructor styled API.
export function diffWorkerPool(): WorkerPoolManager {
	return ensurePool() as unknown as WorkerPoolManager
}

// The render pass's own parse knows the file's grammar before the pool is asked for anything, and
// resolving it (chunk fetch + registration) is longer than the worker boot - so the pass starts it
// there and lets the two overlap (pool.ts prewarmLanguages).
export function prewarmPoolLanguages(diff: FileDiffMetadata): void {
	ensurePool().prewarmLanguages(diff)
}

// The click path's parse, off the main thread as a pool task (priority over window work; it
// needs no shiki, so it streams while the worker initialize round trips run). Undefined means
// the pool declined (small file, failed boot) or failed - the caller keeps the main-thread
// parse, so this can only ever remove work from the click, never add a wait to it.
export function parseDiffInPool(
	input: ParseInput,
): Promise<FileDiffMetadata | undefined> {
	return ensurePool().parseDiff(input)
}

// The whole-file pipeline for one diff: plain base + every token window, band-first. Resolves
// true once the visible band has merged (the mount paints token rows), false when the pool will
// not tokenize the diff (plain, failed boot) and the plain fetch serves the mount instead.
export function openPoolJob(
	diff: FileDiffMetadata,
	viewport?: WindowViewport,
	isWarm = false,
): Promise<boolean> {
	return ensurePool().openFileJob(diff, viewport, isWarm)
}

// Whether the mount can proceed colored right now: a settled grid, a live band-merged job - or
// a diff the pool will never tokenize. The cold-open hold (placeholder.ts) asks this instead of
// peeking at pool internals.
export function poolGridReady(diff: FileDiffMetadata): boolean {
	return ensurePool().isGridReady(diff)
}

// Warm the NEXT file's viewport band while the pool is otherwise idle, so the switch publishes colored
// rows from cache. render/prefetch.ts decides which file and when; the pool only decides whether its
// workers may spend idle time on it (one window of warm budget per drain, never the last free slot).
// A viewport seeds the primed job's plan (windows.ts is LPT-ordered without one): the cold-open overlay
// knows the head rows it paints before any renderer exists.
export function prefetchPoolDiff(
	diff: FileDiffMetadata,
	viewport?: WindowViewport,
): void {
	void openPoolJob(diff, viewport, true)
}

// Boot the pool on idle, while the desk state is still in flight.
//
// The renderer cannot request tokens until the boot settles, and the boot resolves themes and
// spawns the fleet - so waiting for the first render pass to start it puts that whole cost
// between the reviewer and the first colored row. The main-thread plain highlighter starts
// alongside the fleet (never gating it): it only answers the sync plain paths. The scheduling
// lives in main.ts's idle callback, reached through this dynamic import, which keeps the pool's
// graph out of the initial bundle (scripts/bundle-budget.mjs enforces that boundary).
export function warmPoolBoot(): void {
	void ensurePool().warmBoot()
}

// Keep the pool's token settings equal to the current settings, installing on drift. Cheap to
// call per render: the common case is one string compare. Drift invalidates the pool's caches
// and adopts on workers in order - results published before adoption get dropped when their job
// no longer exists, which is exactly the rollback the new settings need.
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
