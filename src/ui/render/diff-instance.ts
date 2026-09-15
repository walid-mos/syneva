import { annotations } from '../annotations'
import { currentChanges, currentComments } from '../changes'
import { cursorResync } from '../cursor'
import { revealThreadLines } from '../expand'
import { markdownRevision } from '../markdown'
import { attachDiffSelectionHandlers } from '../selection'
import { applySkimCollapse, isBlockSkimCollapsed } from '../skim'
import { $, D, S } from '../store'

import { acquireEntry, paintEntry } from './diff-entry'
import { diffKey } from './diff-key'
import { memoizedDiffMetadata } from './diff-metadata'
import { diffOptions } from './diff-options'
import { clearOverviewRuler, scheduleOverviewRuler } from './overview-ruler'
import { renderSignature } from './render-signature'
import { captureScrollAnchor, restoreScrollAnchor } from './scroll-anchor'
import { syncPoolRenderOptions } from './worker-pool'

import type { ReviewState } from '../types'
import type { DiffView } from './diff-key'

type ReviewFile = ReviewState['files'][number]
let lastRenderedKey: string | undefined
let lastRenderedSignature: string | undefined

function afterRender(view: DiffView): void {
	if (!view.isPreviewing) {
		applySkimCollapse()
		revealThreadLines()
	}
	attachDiffSelectionHandlers()
	if (!view.isPreviewing && view.isExpandedUnchanged) scheduleOverviewRuler()
	requestAnimationFrame(cursorResync)
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
				skimCollapsed: isBlockSkimCollapsed(change),
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
	const scrollTop = key === lastRenderedKey && isMounted ? host.scrollTop : 0
	const anchor = isMounted ? captureScrollAnchor() : undefined
	const metadata = memoizedDiffMetadata(file, view)
	const shouldRestoreAnchor = !!anchor && previous?.inst.fileDiff !== metadata
	D.fileDiff = metadata
	const entry = acquireEntry(key, metadata, diffOptions(view))
	D.instance = entry.inst
	paintEntry(entry, metadata, annotations())
	host.scrollTop = scrollTop
	if (shouldRestoreAnchor) restoreScrollAnchor(anchor)
	afterRender(view)
	lastRenderedKey = key
	lastRenderedSignature = signature
}
