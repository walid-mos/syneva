import { DIFFS_TAG_NAME } from '@pierre/diffs'
import { $ } from '@shared/lib/dom'

import { D } from './runtime'
import {
	bindVirtualDiff,
	createVirtualizer,
	RENDER_CHUNK_LINES,
	VirtualDiff,
} from './virtual-diff'
import { diffWorkerPool } from './worker-pool'

import type { AnnotationMeta } from '@entities/review/annotations'
import type { FileDiff } from '@pierre/diffs'
import type {
	FileDiffMetadata,
	FileDiffOptions,
	Virtualizer,
} from '@pierre/diffs'
import type { AnnotationInput } from './types'

type DiffEntry = { wrapper: HTMLElement; inst: FileDiff<AnnotationMeta> }
let virtualizer: Virtualizer | undefined
// The entry still mounted in the pane while its replacement is being built, with whatever else the
// pane holds (a markdown file, the oversized card) and the virtualizer that owned it. Teardown is
// deferred to the incoming paint (see clearPendingSwap), because discarding it up front blanks the
// pane for the whole parse + row build - main-thread work the reviewer would spend staring at nothing.
let pendingSwap:
	| {
			entry?: DiffEntry
			nodes: Element[]
			reveal?: HTMLElement
			virtualizer?: Virtualizer
	  }
	| undefined

function clearPendingSwap(): void {
	if (!pendingSwap) return
	pendingSwap.entry?.inst.cleanUp()
	pendingSwap.virtualizer?.cleanUp()
	for (const node of pendingSwap.nodes) node.remove()
	pendingSwap = undefined
}

// The pane must never reveal an empty wrapper. The library's render() returns before the rows are
// committed (measured: rows land 20-30 ms later on a dense cold file, and its own post-render signal
// fires before them), so hold the outgoing rows until the incoming ones exist, checking once per
// frame and giving up after a bounded wait so a file that renders no rows still appears.
const SWAP_WATCH_FRAMES = 12
function watchSwap(): void {
	if (!pendingSwap) return
	const mounted = pendingSwap.reveal
		?.querySelector(DIFFS_TAG_NAME)
		?.shadowRoot?.querySelector('[data-line]')
	if (mounted || ++watchFrames >= SWAP_WATCH_FRAMES) finishSwap()
	else requestAnimationFrame(watchSwap)
}
let watchFrames = 0

// Complete the swap: drop the outgoing entry and reveal the incoming rows, in the same task so no
// frame shows the pane between the two files.
export function finishSwap(): void {
	if (!pendingSwap) return
	const { reveal } = pendingSwap
	clearPendingSwap()
	watchFrames = 0
	if (reveal) reveal.style.visibility = ''
}

// A replacement view (the oversized card, markdown, an error note, the overview) wiped the pane
// and is not a diff entry, so nothing stages it for the swap - and the incoming wrapper is
// appended, not mounted over it. The pane's children belong to the virtualizer (placeholder.ts
// states the invariant): anything that is not a diff-wrap is outgoing here and goes in the same
// task as whatever replaces it. Shared with paintColdOpen, which removes the card when its
// provisional-rows overlay takes the pane's place during a big file's parse.
export function clearReplacementViews(host: HTMLElement): void {
	for (const node of host.children) {
		if (node.classList.contains('diff-wrap')) continue
		node.remove()
	}
}

function discardEntries(): void {
	// Prevent unmount callbacks from applying the new file's decorations to the old DOM.
	D.instance = null
	clearPendingSwap()
	for (const entry of D.diffCache.values()) {
		if (entry.wrapper.isConnected)
			pendingSwap = { entry, nodes: [], virtualizer }
		else entry.inst.cleanUp()
	}
	D.diffCache.clear()
	clearReplacementViews($('diff'))
	if (pendingSwap) {
		// Everything in the pane right now is the outgoing file; the new wrapper is appended after.
		pendingSwap.nodes = [...$('diff').children]
		virtualizer = undefined
	} else {
		virtualizer?.cleanUp()
		virtualizer = undefined
	}
}

export function acquireEntry(
	key: string,
	metadata: FileDiffMetadata,
	options: FileDiffOptions<AnnotationMeta, undefined>,
): DiffEntry {
	const cached = D.diffCache.get(key)
	if (cached?.wrapper.isConnected) {
		if (
			cached.inst instanceof VirtualDiff &&
			cached.inst.fileDiff !== metadata
		)
			cached.inst.updateMetadata(metadata)
		return cached
	}
	// File/content/view switches discard row DOM; the metadata memo and worker token cache
	// stay warm. Same-view decisions retain the renderer's manually expanded context.
	discardEntries()
	const wrapper = document.createElement('div')
	wrapper.className = 'diff-wrap'
	const pane = $('diff')
	// Appended (the library measures the wrapper) but invisible until paintEntry reveals it in the
	// same task as the row build, so no frame ever shows an empty pane. The pane keeps the outgoing
	// rows, and with them the reviewer's scroll position, for the whole build; the caller sets the
	// incoming file's scroll right after the paint (renderDiffInstance).
	//
	// Hidden only while an outgoing entry still holds the pane. With nothing to hold - a cold boot, the
	// first entry of a session - hiding it left the pane blank until some later pass finished a swap,
	// and the first file's pass is the only one that ever runs: the rows were built, measured, and
	// never revealed, so opening a desk showed an empty pane.
	const holdsPane = !!pendingSwap
	wrapper.style.visibility = holdsPane ? 'hidden' : ''
	pane.append(wrapper)
	// The swap that ends this entry's invisibility is armed with the wrapper it must reveal.
	if (pendingSwap) pendingSwap.reveal = wrapper
	const inst = createWindowedDiff(wrapper, options)
	wrapper.dataset.windowed = 'true'
	const entry = { wrapper, inst }
	D.diffCache.set(key, entry)
	return entry
}

function createWindowedDiff(
	wrapper: HTMLElement,
	options: FileDiffOptions<AnnotationMeta, undefined>,
): VirtualDiff {
	virtualizer = createVirtualizer(wrapper)
	const instance = new VirtualDiff(
		options,
		virtualizer,
		// Mount quantization: this is a per-instance metrics knob (the Virtualizer itself takes none).
		{ hunkLineCount: RENDER_CHUNK_LINES },
		diffWorkerPool(),
	)
	bindVirtualDiff(instance)
	return instance
}

export function paintEntry(
	entry: DiffEntry,
	metadata: FileDiffMetadata,
	lineAnnotations: AnnotationInput[],
): void {
	// Mount before the virtualizer's first visibility/offset measurement.
	const { wrapper } = entry
	let container = wrapper.querySelector<HTMLElement>(DIFFS_TAG_NAME)
	if (!container) {
		container = document.createElement(DIFFS_TAG_NAME)
		// A cold worker leaves an empty shell for a frame. A zero-height file at y=0 is
		// classified as a bottom anchor by Virtualizer, which jumps to the end on first paint.
		container.style.minHeight = '1px'
		wrapper.appendChild(container)
	}
	entry.inst.render({
		fileDiff: metadata,
		lineAnnotations,
		fileContainer: container,
		containerWrapper: wrapper,
	})
	// Rows may already be committed (warm grid): swap in this same task, otherwise per frame until
	// they exist (watchSwap).
	finishSwap()
	if (pendingSwap) requestAnimationFrame(watchSwap)
}
