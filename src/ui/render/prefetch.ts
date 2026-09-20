import { peekContents, prefetchContents } from '../contents'
import { S } from '../store'

import {
	parseInputFor,
	prefetchableMetadata,
	prefetchableParse,
	seedPrefetchedMetadata,
} from './diff-metadata'
import { isExpandCapped } from './expand-cap'
import { parseDiffInPool, prefetchPoolDiff } from './worker-pool'

import type { ReviewState } from '../types'
import type { DiffView } from './diff-key'

type ReviewFile = ReviewState['files'][number]

// Token prefetch for the file the reviewer will most likely open next: the row below the one on screen.
// The metric he feels is click -> colored rows, and the wait is a tokenize pass he watches as grey rows,
// so warming the next file's viewport band while the pool is idle is what turns the next click into a
// publish from cache (pool.ts caps the warm job to one window per drain, never the last slot).
//
// Sequential order on purpose: the guide's own order lives in bindings/navigate.ts, and importing it
// here would drag the navigation bindings into the render graph for a prefetch whose wrong guess costs
// idle worker time and nothing else.

// The contents of the next file are normally already in the cache (every navigation prefetches them,
// contents.ts). On the first file of a session they are not, so the attempt waits for that one request
// on a bounded timer and gives up: the click path is unchanged either way.
const RETRY_MS = 120
const MAX_TRIES = 8

// path + revision + everything that changes the parse (diff-metadata's fingerprint inputs we can know
// here), so a re-render for any other reason does not re-open a job for the same content.
let warmed = ''

// Called at the end of every render pass (diff-instance.ts) - the pass that just planned the visible
// file and leaves the pool with idle workers. Cheap when nothing changed: one string compare.
export function warmNextFileTokens(file: ReviewFile, view: DiffView): void {
	// A preview pass is the reviewer reading an unchanged file from the tree: the diff behind it will
	// re-render (and re-enter here) when he comes back, so there is nothing to warm yet.
	if (view.isPreviewing) return
	// A preview (an unchanged file opened from the tree), or a file outside the review order, has no
	// "next".
	const files = S.state?.files
	const index = files?.indexOf(file) ?? -1
	const next = index >= 0 ? files?.[index + 1] : undefined
	if (!next) return
	// The view flags are a per-file decision (render.ts currentView reads isExpandCapped on the file's
	// own contents), so the next file's view is derived here rather than inherited from the visible one:
	// a warm job whose diff was parsed for different flags would paint rows against the wrong structure.
	const stamp = [
		next.path,
		next.contentHash,
		S.settings.unchangedLines === 'expand' ? 'e' : 'c',
		S.settings.theme,
		S.settings.lineDiffType,
	].join('\u0000')
	if (stamp === warmed) return
	warmed = stamp
	void warm(next)
}

async function warm(next: ReviewFile): Promise<void> {
	const contents = await cachedContents(next, MAX_TRIES)
	if (!contents) return
	const view: DiffView = {
		// The next file in review order is always a diff: a preview is the file the reviewer opened from the
		// tree, and that one is not in `state.files` at all (the index check above returns first).
		isPreviewing: false,
		isExpandedUnchanged:
			S.settings.unchangedLines === 'expand' &&
			!isExpandCapped(contents.newContents),
	}
	// Eligibility and the parse's shape come from diff-metadata (it owns that decision), the
	// off-thread attempt from the pool's parse task. When the pool answers, the click finds a memo
	// hit and the main thread never diffed the file at all; when it declines (small file, failed
	// boot) or fails, today's synchronous parse runs unchanged - so this can lose the warming,
	// never the click. The offload's own stage: `render:parse` only covers what the MAIN thread
	// paid, so this stamp is what tells a bench (or a slow desk in the field) whether the prefetch
	// parsed off-thread at all.
	const plan = prefetchableParse(next, view)
	if (!plan) return
	const offThread = await parseDiffInPool(
		parseInputFor(next, plan.contents, plan.isViewOnly),
	)
	if (offThread) {
		seedPrefetchedMetadata(next, plan.contents, plan.isViewOnly, offThread)
		prefetchPoolDiff(offThread)
		return
	}
	const metadata = prefetchableMetadata(next, view)
	if (metadata) prefetchPoolDiff(metadata)
}

// One attempt per bounded wait, recursively rather than in a loop: `prefetchContents` is idempotent
// and cache-checked (it only nudges a fetch navigation usually started already), so each attempt is a
// readiness check on the same request until the tries run out.
function cachedContents(
	file: ReviewFile,
	triesLeft: number,
): Promise<ReturnType<typeof peekContents>> {
	prefetchContents(file)
	const cached = peekContents(file)
	if (cached || triesLeft <= 0) return Promise.resolve(cached)
	return new Promise(resolve => setTimeout(resolve, RETRY_MS)).then(() =>
		cachedContents(file, triesLeft - 1),
	)
}
