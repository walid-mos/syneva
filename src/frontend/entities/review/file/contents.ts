import { perfMark } from '@shared/lib/perf'

import { fetchFileContents } from './api'

import type { PreviewFile, ReviewFile } from '../model'

type ReviewFileT = ReviewFile

// Per-file old/new contents fetched from GET /api/file-contents, so the render path no
// longer reads them off the polled ReviewState (issue 04 removes the embedded copies entirely). A small
// client-side LRU keeps recently opened files warm (matching the render instance cache's size), so
// re-opening a visited file re-renders without a round-trip. Preview files (opened from the tree
// via /api/file) carry their contents inline and never hit this cache - see loadCurrentContents.

type Contents = { oldContents: string; newContents: string }

const CACHE_CAP = 30
// Keyed path + contentHash: a reload that rewrites a file changes its hash, so the stale entry
// falls out on its own (mirrors the server-side cache token).
const cache = new Map<string, Contents>()
const cacheKey = (f: ReviewFileT): string => `${f.path}\0${f.contentHash}`

// The current file's resolved contents. The render pass and its synchronous helpers
// (currentSplittable, the markdown/anchor readers) read from here instead of fetching per call.
// `path` records which file these belong to so a helper can tell when they're not yet loaded for
// the current file (before the first fetch resolves).
export const cur: {
	path: string | null
	oldContents: string
	newContents: string
} = {
	path: null,
	oldContents: '',
	newContents: '',
}

// Cache-only lookup (no fetch, no LRU touch). Preview files answer from their inline
// contents - the caller passes the preview it currently shows (null when none).
export function peekContents(
	f: ReviewFileT,
	preview: PreviewFile | null,
): Contents | null {
	if (preview && f === preview)
		return {
			oldContents: preview.previewContents,
			newContents: preview.previewContents,
		}
	return cache.get(cacheKey(f)) ?? null
}

async function fetchContents(f: ReviewFileT): Promise<Contents> {
	const key = cacheKey(f)
	const hit = cache.get(key)
	if (hit) {
		cache.delete(key) // re-insert → most-recently-used
		cache.set(key, hit)
		return hit
	}
	const started = performance.now()
	const r = await fetchFileContents(f.path)
	perfMark('contents:loaded', {
		ms: Math.round(performance.now() - started),
		bytes: r.oldContents?.length ?? 0,
	})
	const val = { oldContents: r.oldContents, newContents: r.newContents }
	cache.set(key, val)
	while (cache.size > CACHE_CAP) {
		const oldest = cache.keys().next()
		if (oldest.done) break
		cache.delete(oldest.value)
	}
	return val
}

// Opportunistically warm the NEXT file's contents into the same LRU the real open reads, so the
// common next-file navigation never waits on the wire. Fire-and-forget: it only warms the cache  -
// it never touches `cur`, so a late prefetch can't clobber the current file's render (the stale
// guard in loadCurrentContents is untouched). Skips oversized placeholders (they never fetch
// contents until "Load diff anyway" - same test as oversized.ts's isOversizedPlaceholder, inlined
// to avoid an import cycle) and cache hits. At most one prefetch in flight (a plain busy flag - no
// queue; opportunistic warming, not a guarantee). A failure is swallowed: the real open re-fetches
// and shows the error card.
let isPrefetching = false

// Fetch one file's contents into the cache, holding `isPrefetching` for the duration. A failed
// warm-up is silent: the real open re-fetches and renders the error card itself.
async function prefetch(f: ReviewFileT): Promise<void> {
	try {
		await fetchContents(f)
	} catch {
		// opportunistic warming only
	} finally {
		isPrefetching = false
	}
}

// `loadedOversized` is the session's "Load diff anyway" set (the store owns it): a placeholder
// file outside it never fetches contents.
export function prefetchContents(
	f: ReviewFileT | null | undefined,
	loadedOversized: Set<string>,
): void {
	if (!f || isPrefetching) return
	if (f.oversized && !loadedOversized.has(f.path)) return // placeholder - never fetch
	if (cache.has(cacheKey(f))) return // already warm
	isPrefetching = true
	void prefetch(f)
}

// Load `file`'s contents into `cur` before it renders. Returns:
//   "ok"    - cur now holds this file's contents;
//   "stale" - the reviewer switched files while the fetch was in flight (the response is for a
//             file that is no longer current), so cur was left untouched and this render must
//             abort - a newer render() for the now-current file is already running;
//   "error" - the fetch failed (git object gone after a rebase, transport error); the caller
//             renders an error card.
// The stale guard is why the in-flight request is pinned to the file it was issued for: a late
// response must never render into, or seed `cur` for, the wrong file. The caller supplies the
// selected file (null = nothing to show: cur is emptied), the preview it currently shows, and the
// currency check (`stillCurrent()` re-reads the store at await-resume time).
export async function loadCurrentContents(
	file: ReviewFileT | null,
	preview: PreviewFile | null,
	stillCurrent: () => boolean,
): Promise<'ok' | 'stale' | 'error'> {
	if (!file) {
		cur.path = null
		cur.oldContents = ''
		cur.newContents = ''
		return 'ok'
	}
	const f = file
	// A preview carries its contents inline (fetched from /api/file); nothing to fetch.
	if (preview && f === preview) {
		cur.path = f.path
		cur.oldContents = preview.previewContents
		cur.newContents = preview.previewContents
		return 'ok'
	}
	try {
		const { oldContents, newContents } = await fetchContents(f)
		if (!stillCurrent()) return 'stale' // switched files mid-fetch - drop this pass
		cur.path = f.path
		cur.oldContents = oldContents
		cur.newContents = newContents
		return 'ok'
	} catch {
		if (!stillCurrent()) return 'stale'
		return 'error'
	}
}

// Split view only makes sense for a two-sided diff. A new file (no old side), a deleted file
// (no new side), or a view-only full file (old === new - including any preview) render
// single-column, so split is a no-op - used to render them unified and to disable the toggle.
// A contents-derived predicate: the caller passes the selected file (preview included);
// until this file's contents are loaded, default to splittable - the render pass awaits the
// fetch before it reads this, so the meaningful call sites see real bytes.
export function currentSplittable(f: ReviewFileT | null | undefined): boolean {
	if (!f) return true
	if (cur.path !== f.path) return true
	const o = cur.oldContents,
		n = cur.newContents
	return o !== '' && n !== '' && o !== n
}
