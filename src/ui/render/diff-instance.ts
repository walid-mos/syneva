import { annotations } from '../annotations'
import { currentChanges, currentComments } from '../changes'
import { cursorResync } from '../cursor'
import { revealThreadLines } from '../expand'
import { markdownRevision } from '../markdown'
import { perfMark, perfSpan } from '../perf'
import { attachDiffSelectionHandlers } from '../selection'
import { $, D, S } from '../store'

import { acquireEntry, paintEntry } from './diff-entry'
import { diffKey } from './diff-key'
import { memoizedDiffMetadata } from './diff-metadata'
import { diffOptions } from './diff-options'
import { clearOverviewRuler, scheduleOverviewRuler } from './overview-ruler'
import { paintColdOpen, resetColdOpen } from './placeholder'
import { warmNextFileTokens } from './prefetch'
import { renderSignature } from './render-signature'
import { captureScrollAnchor, restoreScrollAnchor } from './scroll-anchor'
import { prewarmPoolLanguages, syncPoolRenderOptions } from './worker-pool'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { ReviewState } from '../types'
import type { DiffView } from './diff-key'

// One placeholder (render/placeholder.ts) per diff key, owned by that module: the pass that paints it
// returns immediately so the rows reach the screen, re-schedules itself, and that re-run parses.
type ReviewFile = ReviewState['files'][number]
let lastRenderedKey: string | undefined
let lastRenderedSignature: string | undefined

function afterRender(view: DiffView): void {
	// The real rows are mounted (or on their way): a later cold pass for this file - the parse memo
	// evicts - is allowed to paint a placeholder again.
	resetColdOpen()
	if (!view.isPreviewing) {
		revealThreadLines()
	}
	attachDiffSelectionHandlers()
	if (!view.isPreviewing && view.isExpandedUnchanged) scheduleOverviewRuler()
	requestAnimationFrame(cursorResync)
}

// Parse+replay the current file's metadata, timed: on a cold file this is jsdiff's parse plus the
// decision replay, and it blocks the first paint of the rows. It is also the first moment this pass
// knows which grammar the file needs, so it starts the pool's grammar resolve here: that resolve is
// a chunk fetch plus registration, longer than the worker boot, and prewarming it lets it overlap
// the boot instead of queueing behind it (pool.ts prewarmLanguages).
function parseMetadata(file: ReviewFile, view: DiffView): FileDiffMetadata {
	const endParse = perfSpan('render:parse')
	const metadata = memoizedDiffMetadata(file, view)
	endParse()
	prewarmPoolLanguages(metadata)
	return metadata
}

export function renderDiffInstance(file: ReviewFile, view: DiffView): void {
	syncPoolRenderOptions()
	const key = diffKey(file, view)
	const signature =
		markdownRevision +
		renderSignature(
			file,
			view,
			currentChanges().map(change => ({
				id: change.id,
				status: change.status,
			})),
			{ comments: currentComments(), composer: S },
		)
	const host = $('diff')
	const previous = D.diffCache.get(key)
	const isMounted = previous?.wrapper === host.firstElementChild
	if (
		key === lastRenderedKey &&
		signature === lastRenderedSignature &&
		isMounted &&
		D.fileDiff === previous.inst.fileDiff
	)
		return
	clearOverviewRuler()
	// Cold metadata on a big file: the parse would run inline here and hold the main thread for the
	// whole time it takes (measured 187 ms at 3 700 lines, 1 339 ms on a full rewrite), so the first
	// thing a reviewer would see is an empty pane. The placeholder paints the file's opening rows and
	// re-schedules this pass, which is where the parse then runs.
	if (paintColdOpen(host, file, view, key)) return
	const scrollTop = key === lastRenderedKey && isMounted ? host.scrollTop : 0
	const anchor = isMounted ? captureScrollAnchor() : undefined
	const metadata = parseMetadata(file, view)
	const shouldRestoreAnchor = !!anchor && previous?.inst.fileDiff !== metadata
	D.fileDiff = metadata
	// Timed apart: a cold open blocks the main thread here (hundreds of ms, measured), which delays
	// every pool dispatch and publish queued behind it - so the split between getting the grid and
	// getting it onto the page is what tells the next optimization where to go.
	const endAcquire = perfSpan('render:acquire')
	const entry = acquireEntry(key, metadata, diffOptions(view))
	endAcquire()
	D.instance = entry.inst
	const endPaint = perfSpan('render:paint')
	paintEntry(entry, metadata, annotations())
	endPaint()
	perfMark('render:painted')
	host.scrollTop = scrollTop
	if (shouldRestoreAnchor) restoreScrollAnchor(anchor)
	afterRender(view)
	lastRenderedKey = key
	lastRenderedSignature = signature
	// Last, and after this pass has planned the visible file: the pool is now idle, which is when the
	// next file's viewport band can be tokenized without taking a slot from what is on screen.
	warmNextFileTokens(file, view)
}
