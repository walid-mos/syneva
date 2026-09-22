import { STATIC_PATHS } from '@contracts/routes'
import { DEFAULT_TOKEN_OPTIONS } from '@shared/diff-renderer/token-pool/plain'
import {
	TokenPool,
	WORKER_POOL_SIZE,
} from '@shared/diff-renderer/token-pool/pool'

import { diffCtx } from './context'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { WorkerPoolManager } from '@pierre/diffs/worker'
import type { ParseInput } from '@shared/diff-renderer/parse-input'
import type { WindowViewport } from '@shared/diff-renderer/token-pool/windows'
import type { VirtualDiff } from './virtual-diff'

// The token pool: Shiki tokenization/highlighting runs in Web Workers on windowed slices of each
// diff (render/token-pool/pool.ts) instead of one whole-file task, so a 16k-line sparse file
// streams colored rows in ~1 s instead of paying a ~53 s single task. The pool owns the plain
// base, the merge grid and the publishes; the mount paints plain rows and every publish lands
// as a highlighted flip (pool.ts publishNow clears the renderer's cache first), so color
// always reaches the rows on screen.
//
// Token-relevant settings (theme, per-line diff) must reach the POOL - syncPoolRenderOptions()
// at every render pass - or cached token grids go stale for the current settings (the pool
// invalidates its job state and re-adopts on drift). The worker script is dist/worker.js, built
// and served by the desk (scripts/build-ui.mjs entry → src/frontend/worker/diff-token-worker.ts,
// STATIC_PATHS.worker route). The grammar set is NOT in the worker bundle - the pool resolves a diff's
// grammars on the main thread (lazily, one chunk per language) and ships the resolved data to
// whichever workers run that file.
//
// Slot sizing (pool.ts WORKER_POOL_SIZE) is the memory budget, not the core count: one core is
// left to the main thread (merges, publishes and @pierre's layout all run there) and one to the
// OS. Measured on the 6-core bench machine (history.json, milestone "parallel"): the 5th worker
// cut the 16k-line fixture's token phase from 1614 ms to 1275 ms (-21%) while a normal file's
// open stayed inside run-to-run noise.
export const WORKER_URL = STATIC_PATHS.worker

let poolSingleton: TokenPool | null = null
const preparedRefreshes = new WeakMap<VirtualDiff, () => void>()
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
			theme: {
				dark: diffCtx().S.settings.theme,
				light: diffCtx().S.settings.theme,
			},
			lineDiffType: diffCtx().S.settings.lineDiffType,
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

// Warm the NEXT file's viewport band while the pool is otherwise idle, so the switch finds
// colored rows in the caches. render/prefetch.ts decides which file and when; the pool only
// decides whether its workers may spend idle time on it (one window of warm budget per drain,
// never the last free slot).
export function prefetchPoolDiff(
	diff: FileDiffMetadata,
	viewport?: WindowViewport,
): void {
	void ensurePool().primeJob(diff, viewport)
}

// Before the first island mount, prepare exactly the estimated visible band. The
// caller awaits only this bounded window; the pool keeps streaming adjacent/full
// windows after @pierre adopts the partially colored grid.
export function preparePoolViewport(
	diff: FileDiffMetadata,
	viewport: WindowViewport,
): Promise<boolean> {
	return ensurePool().prepareViewport(diff, viewport)
}

export function attachPreparedRenderer(
	diff: FileDiffMetadata,
	instance: VirtualDiff,
): void {
	let refresh = preparedRefreshes.get(instance)
	if (!refresh) {
		refresh = () => instance.rerender()
		preparedRefreshes.set(instance, refresh)
	}
	ensurePool().attachPreparedRefresh(diff, refresh)
}

// The rendered slice is also the reviewer's viewport - but a cache-hit range (the renderer's
// renderCache holds the full grid) serves rows without a plain fetch, so the pool would never
// learn the reviewer jumped. Called from onPostRender every time rows commit.
//
// The renderer's render range counts EMITTED unified rows (a 1:1 change emits a deletion row
// and an addition row for one content slot), while the pool's window plan counts content slots
// - the two spaces drift apart as changes accumulate, so the range is converted through the
// same emission list the island already caches (its rows() = virtualLines with the renderer's
// own expansion options). The first emitted row's line number minus one is its content slot.
export function noteRenderedViewport(inst: VirtualDiff): void {
	const key = inst.fileDiff?.cacheKey
	if (!key) return
	const view = inst.renderedViewport()
	if (!view) return
	const rows = inst.rows()
	const first = rows.at(view.start)
	const last = rows.at(view.start + view.count - 1)
	if (!first || !last) {
		ensurePool().noteViewport(key, view.start, view.count)
		return
	}
	const start = first.line - 1
	const total = last.line - start
	if (!Number.isFinite(start) || total <= 0) return
	ensurePool().noteViewport(key, start, total)
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
		diffCtx().S.settings.theme,
		diffCtx().S.settings.lineDiffType,
	])
	if (signature === lastSyncedOptions) return
	lastSyncedOptions = signature
	// Fire-and-forget: adoption broadcasts to subscribers (~pierre's onThemeChange path) once
	// the workers have settled.
	void diffWorkerPool().setRenderOptions({
		theme: {
			dark: diffCtx().S.settings.theme,
			light: diffCtx().S.settings.theme,
		},
		lineDiffType: diffCtx().S.settings.lineDiffType,
	})
}
