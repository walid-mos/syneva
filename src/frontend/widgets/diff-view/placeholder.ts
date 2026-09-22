import { cur } from '@entities/review/file/contents'
// A cold open of a big file cannot paint its real rows before jsdiff has parsed both sides, and that
// parse is size-dependent (measured 187 ms at 3 700 lines, 1 339 ms when the file is fully rewritten)
// - no frame, no rows, nothing readable until it returns. The placeholder breaks that dependency: the
// opening rows of the new side go up as soon as the contents are in hand, while the parse runs in the
// token pool. When the parse lands, the mount paints plain rows immediately; the job opens through
// @pierre's own highlight request and every publish repaints the island (worker-pool.ts), so the
// color follows the moment windows land - the reviewer stationary included.
//
// It is deliberately not a diff: the old side and the change marks are exactly what the parse
// produces, so there is nothing to show of them without it. What it does show is genuinely the file
// the reviewer asked to read, which is the point - one frame to readable, whatever the file's size.
//
// It lives in a fixed layer over the pane rather than as a child of it: the pane's children belong to
// @pierre's virtualizer (diff-entry mounts, measures and reveals the wrapper), so a pointer
// transparent layer positioned from the pane's own rect leaves that bookkeeping untouched.
import { DIFFS_TAG_NAME } from '@pierre/diffs'
import { perfMark } from '@shared/lib/perf'

import { diffCtx } from './context'
import { clearReplacementViews } from './diff-entry'
import {
	isParseMemoized,
	isViewOnly,
	parseInputFor,
	seedPrefetchedMetadata,
} from './diff-metadata'
import { placeholderRows, shouldPlaceholder } from './placeholder-slice'
import { parseDiffInPool } from './worker-pool'

import type { ReviewState } from '@entities/review/model'
import type { DiffView } from './diff-key'

type ReviewFile = ReviewState['files'][number]

// Bounded reveal watch, like the pane's own swap watch: a render that never produces rows must not
// leave the layer covering the pane forever (~10 s at 60 fps).
const REVEAL_WATCH_FRAMES = 600

let overlay: HTMLElement | undefined
let overlayHost: HTMLElement | undefined
let overlayScrollHost: HTMLElement | undefined
let watchFrames = 0
// The diff key whose placeholder is currently standing in for the parse. Without it the re-scheduled
// pass - which finds the parse still cold, since it is the pass that is about to do it - would paint
// provisional rows again and never reach the diff.
let placeholderKey: string | undefined

// The render keys whose off-thread parse is still running: the pass the overlay re-scheduled must
// stand aside - the settle deletes the key, seeds the parse memo and re-renders, so no pass parses
// inline behind a pipeline that already owns the file.
const pendingParse = new Set<string>()

// The cold-open policy. A diff whose parse is not memoized and whose file is long enough that the
// parse would be a visible wait paints provisional rows and hands the parse to the pool; the settle
// re-renders and the mount paints plain rows that the publishes color in. A memoized parse mounts
// at once - same path. Returns true when it painted the hold - the caller must then skip this
// pass entirely and let the scheduled re-render do the work.
export function paintColdOpen(
	host: HTMLElement,
	file: ReviewFile,
	view: DiffView,
	key: string,
): boolean {
	if (placeholderKey === key) {
		// The pass after the overlay: stand aside while the pool's parse runs; its settle deletes
		// the key and re-renders.
		return pendingParse.has(key)
	}
	if (isParseMemoized(file, view)) return false
	if (!shouldPlaceholder(cur.newContents)) return false
	placeholderKey = key
	perfMark('render:placeholder')
	// Once the provisional rows cover the pane, the outgoing replacement view (the oversized card
	// a "Load diff anyway" click just left there) must go: beneath the overlay it read as the
	// click doing nothing (the card came back for the whole parse), and its presence made the
	// reveal watch classify the pane as 'gone' and clear the overlay one frame later. An unpainted
	// overlay leaves the view in place - something readable beats a blank pane.
	if (paintPlaceholderOverlay(host, cur.newContents))
		clearReplacementViews(host)
	// Hand the click's parse to the pool NOW (a priority task, no shiki needed - it streams while
	// the worker boot runs): the overlay holds the pane while the workers diff, the resolve seeds
	// the parse memo, and the re-render mounts - plain rows first, color on the publishes. A
	// declined or failed parse resolves undefined and the re-scheduled pass below falls back to
	// today's inline parse - this only ever removes work from the click.
	const contents = cur
	const viewOnly = isViewOnly(view.isPreviewing)
	pendingParse.add(key)
	void (async (): Promise<void> => {
		const diff = await parseDiffInPool(
			parseInputFor(file, contents, viewOnly),
		)
		pendingParse.delete(key)
		if (diff) seedPrefetchedMetadata(file, contents, viewOnly, diff)
		diffCtx().deferRender()
	})()
	// The parse must run on a pass that is free to block: deferRender paints first (its own double
	// frame) and only then calls render() again - which now finds the pipeline in flight and waits
	// for it, or parses inline if the pool declined.
	diffCtx().deferRender()
	return true
}

// A pass that mounted the real rows frees the policy again: the parse memo evicts, so the same file
// can go cold later and is worth a placeholder then too. Called from the island's afterRender.
export function resetColdOpen(): void {
	placeholderKey = undefined
}

// Unlike diff-entry's swap watch, this one reads the pane's LAST child: the incoming wrapper is
// appended last (the outgoing rows keep the pane until the swap), so the placeholder only stands
// aside for rows that belong to the file it was painted for. A pane holding something that is not a
// diff at all (the guide, an oversized card, an error note) means the diff was replaced: no rows are
// coming, and the layer would cover the replacement.
function paneState(host: HTMLElement): 'rows' | 'waiting' | 'gone' {
	const wrapper = host.lastElementChild
	if (!wrapper) return 'waiting'
	if (!(wrapper instanceof HTMLElement)) return 'gone'
	if (!wrapper.classList.contains('diff-wrap')) return 'gone'
	if (wrapper.style.visibility === 'hidden') return 'waiting'
	const rows = wrapper
		.querySelector(DIFFS_TAG_NAME)
		?.shadowRoot?.querySelector('[data-line]')
	return rows ? 'rows' : 'waiting'
}

function watchReveal(): void {
	const host = overlayHost
	if (!overlay || !host) return
	const state = paneState(host)
	// Rows here are the mount's plain rows - the publishes color them in (worker-pool.ts
	// repaints the island for every publish of the file on screen). A scroll always clears at
	// once - the reviewer moves, the pane shows whatever is there - and a mount that never
	// produces rows is bounded by the same cap as every other wait (~10 s at 60 fps).
	const capped = ++watchFrames >= REVEAL_WATCH_FRAMES
	if (!host.isConnected || state !== 'waiting' || capped) {
		clearPlaceholderOverlay()
		return
	}
	requestAnimationFrame(watchReveal)
}

export function clearPlaceholderOverlay(): void {
	if (overlay) perfMark('render:placeholder-cleared')
	overlayScrollHost?.removeEventListener('scroll', clearPlaceholderOverlay)
	overlay?.remove()
	overlay = undefined
	overlayHost = undefined
	overlayScrollHost = undefined
}

// Paint the provisional rows over the pane. Positioning is fixed and read once from the pane's own
// box: the pane is the scroller, and a layer inside it would take part in the scroll geometry the
// virtualizer measures. A scroll means the reviewer is navigating, so the layer gets out of the way
// instead of pretending to be content that scrolls.
export function paintPlaceholderOverlay(
	host: HTMLElement,
	contents: string,
): boolean {
	const rows = placeholderRows(contents)
	if (!rows.length) return false
	const rect = host.getBoundingClientRect()
	if (rect.width < 1 || rect.height < 1) return false
	clearPlaceholderOverlay()
	const layer = document.createElement('div')
	layer.className = 'diff-placeholder'
	layer.setAttribute('aria-hidden', 'true')
	layer.style.left = `${rect.left}px`
	layer.style.top = `${rect.top}px`
	layer.style.width = `${rect.width}px`
	layer.style.height = `${rect.height}px`
	for (const row of rows) {
		const line = document.createElement('div')
		line.className = 'diff-placeholder-row'
		const gutter = document.createElement('span')
		gutter.className = 'diff-placeholder-no'
		gutter.textContent = String(row.no)
		const text = document.createElement('span')
		// Contents are the reviewer's own files: text, never markup.
		text.textContent = row.text
		line.append(gutter, text)
		layer.append(line)
	}
	document.body.append(layer)
	overlay = layer
	overlayHost = host
	overlayScrollHost = host
	host.addEventListener('scroll', clearPlaceholderOverlay, { passive: true })
	watchFrames = 0
	requestAnimationFrame(watchReveal)
	return true
}
