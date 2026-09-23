import {
	currentChanges,
	currentComments,
	currentFileOrNull,
} from '@entities/review/changes'
import { revealThreadLines } from '@features/expand-context/expand'
import { attachDiffSelectionHandlers } from '@features/manage-comment/selection'
import { $ } from '@shared/lib/dom'
import { perfMark, perfSpan } from '@shared/lib/perf'
import { markdownRevision } from '@shared/markdown'

import { annotations } from './annotations'
import { diffCtx } from './context'
import { cursorResync } from './cursor'
import { acquireEntry, paintEntry } from './diff-entry'
import { diffKey } from './diff-key'
import { memoizedDiffMetadata } from './diff-metadata'
import { diffOptions } from './diff-options'
import { registerDiffEngine } from './engine'
import { prepareInitialPaint } from './initial-paint'
import { clearOverviewRuler, scheduleOverviewRuler } from './overview-ruler'
import { paintColdOpen, resetColdOpen } from './placeholder'
import { warmNextFileTokens } from './prefetch'
import { renderSignature } from './render-signature'
import { D } from './runtime'
import { VirtualDiff } from './virtual-diff'
import { captureScrollAnchor, restoreScrollAnchor } from './scroll-anchor'
import { prewarmPoolLanguages, syncPoolRenderOptions } from './worker-pool'

import type { DiffEngine } from './engine'

import type { ReviewState } from '@entities/review/model'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { DiffView } from './diff-key'

// One placeholder (render/placeholder.ts) per diff key, owned by that module: the pass that paints it
// returns immediately so the rows reach the screen, re-schedules itself, and that re-run parses.
type ReviewFile = ReviewState['files'][number]
let lastRenderedKey: string | undefined
let lastRenderedSignature: string | undefined
// Token preparation is async; a later file switch owns the paint and invalidates
// an older preparation before it can replace the mounted pane.
let renderGeneration = 0

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

// The current file's change/comment/composer fingerprint (see render-signature.ts): identical
// signature + same mounted wrapper + same metadata ⇒ skip the repaint.
function currentSignature(file: ReviewFile, view: DiffView): string {
	return (
		markdownRevision +
		renderSignature(
			file,
			view,
			currentChanges(
				diffCtx().S.state,
				currentFileOrNull(
					diffCtx().S.state?.files,
					diffCtx().S.preview,
					diffCtx().S.fileIndex,
				),
			).map(change => ({
				id: change.id,
				status: change.status,
			})),
			{
				comments: currentComments(
					diffCtx().S.state,
					currentFileOrNull(
						diffCtx().S.state?.files,
						diffCtx().S.preview,
						diffCtx().S.fileIndex,
					),
				),
				composer: diffCtx().S,
			},
		)
	)
}

// The cheap delta (perf: one decision or comment must not repaint the whole
// wrapper). Runs when the SAME diff entry is already mounted: diffKey covers the
// file identity, content, base diff and every render option, so any signature
// delta on a key match is annotation-bearing by construction - changes (the
// decision set), comments, or composer state. The mounted wrapper stays; the
// library's layout-reset seam (updateMetadata) re-adopts a re-replayed metadata
// object without a wrapper teardown, retaining the renderer's manually expanded
// context, and setLineAnnotations + rerender repaint the annotation slots.
// Scroll: the wrapper element is never swapped, but a decision ABOVE the viewport
// still renumbers the document (an accepted band merges into context), so the same
// capture/restore seam the full pass uses runs around the re-adoption - the anchor
// is read against the OLD mounted rows and OLD line map, then restored through the
// NEW map after the rerender (reveal() no-ops when the line left the layout).
// Returns false whenever the gate doesn't hold - the caller runs the full pass.
function updateMountedDelta(
	file: ReviewFile,
	view: DiffView,
	key: string,
	signature: string,
): boolean {
	const previous = D.diffCache.get(key)
	const host = $('diff')
	if (
		!previous ||
		key !== lastRenderedKey ||
		previous.wrapper !== host.firstElementChild
	)
		return false
	const anchor = captureScrollAnchor()
	// Timed apart from the adopt/paint below: the delta path's whole premise is that
	// the metadata rebuild (parse memo hit + replay of the decisions) stays cheap next
	// to the full pass - this mark is what proves or refutes that on big files.
	const endDeltaMetadata = perfSpan('render:delta:metadata')
	const metadata = parseMetadata(file, view)
	endDeltaMetadata()
	const { inst } = previous
	inst.setLineAnnotations(annotations())
	// updateMetadata is the VirtualDiff adapter's seam (base FileDiff has none), so
	// the metadata re-adoption is guarded like acquireEntry's cache reuse is.
	const endDeltaPaint = perfSpan('render:delta:paint')
	if (inst instanceof VirtualDiff && inst.fileDiff !== metadata)
		inst.updateMetadata(metadata)
	else inst.rerender()
	endDeltaPaint()
	if (anchor) restoreScrollAnchor(anchor)
	D.fileDiff = metadata
	lastRenderedKey = key
	lastRenderedSignature = signature
	afterRender(view)
	return true
}

// Skip/delta paths for an already-painted entry; true when the caller has nothing
// left to do. Identical key+signature+metadata: no-op. Signature delta on the same
// mounted entry: the cheap delta paints only what the decision/comment/composer
// change moved (see updateMountedDelta). Everything else - file switches, view
// changes, cold boots - falls through to the full pass.
function reuseMountedEntry(
	file: ReviewFile,
	view: DiffView,
	key: string,
	signature: string,
): boolean {
	const host = $('diff')
	const previous = D.diffCache.get(key)
	const isMounted = previous?.wrapper === host.firstElementChild
	if (!isMounted || !previous) return false
	if (
		key === lastRenderedKey &&
		signature === lastRenderedSignature &&
		D.fileDiff === previous.inst.fileDiff
	)
		return true
	return updateMountedDelta(file, view, key, signature)
}

export async function renderDiffInstance(
	file: ReviewFile,
	view: DiffView,
): Promise<void> {
	const generation = ++renderGeneration
	syncPoolRenderOptions()
	const key = diffKey(file, view)
	const signature = currentSignature(file, view)
	const host = $('diff')
	const previous = D.diffCache.get(key)
	const isMounted = previous?.wrapper === host.firstElementChild
	if (reuseMountedEntry(file, view, key, signature)) return
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
	const options = diffOptions(view)
	await prepareInitialPaint(metadata, options)
	if (generation !== renderGeneration) return
	D.fileDiff = metadata
	// Timed apart: a cold open blocks the main thread here (hundreds of ms, measured), which delays
	// every pool dispatch and publish queued behind it - so the split between getting the grid and
	// getting it onto the page is what tells the next optimization where to go.
	const endAcquire = perfSpan('render:acquire')
	const entry = acquireEntry(key, metadata, options)
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

// Engine seam handles. detachInstance mirrors the funnel's detach (the next replacement view
// owns the pane); disposeInstances is the session teardown (every cached entry unmounted).
export function detachInstance(): void {
	clearOverviewRuler()
	D.instance = null
	D.lineMap = null
}

export function disposeInstances(): void {
	for (const entry of D.diffCache.values()) {
		if (!entry.wrapper.isConnected) entry.inst.cleanUp()
	}
	D.diffCache.clear()
	D.instance = null
	D.lineMap = null
}

function createDiffEngine(): DiffEngine {
	return {
		mount() {
			// Single-host desk: the leaf modules resolve #diff/#ovr through dom.$ - the
			// parameters pin that contract in the type (see engine.ts).
		},
		applyModel({ file, view }) {
			return renderDiffInstance(file, view)
		},
		updateAnnotations({ file, view }) {
			return updateMountedDelta(
				file,
				view,
				diffKey(file, view),
				currentSignature(file, view),
			)
		},
		clear: detachInstance,
		dispose: disposeInstances,
	}
}

registerDiffEngine(createDiffEngine())
