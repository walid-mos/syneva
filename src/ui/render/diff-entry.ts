import { DIFFS_TAG_NAME, FileDiff } from '@pierre/diffs'

import { currentChanges } from '../changes'
import { isBlockSkimCollapsed } from '../skim'
import { $, D } from '../store'

import { bindVirtualDiff, createVirtualizer, VirtualDiff } from './virtual-diff'
import { diffWorkerPool } from './worker-pool'

import type {
	FileDiffMetadata,
	FileDiffOptions,
	Virtualizer,
} from '@pierre/diffs'
import type { AnnotationInput, AnnotationMeta } from '../types'

type DiffEntry = { wrapper: HTMLElement; inst: FileDiff<AnnotationMeta> }
let virtualizer: Virtualizer | undefined

function discardEntries(): void {
	// Prevent unmount callbacks from applying the new file's decorations to the old DOM.
	D.instance = null
	for (const entry of D.diffCache.values()) entry.inst.cleanUp()
	D.diffCache.clear()
	virtualizer?.cleanUp()
	virtualizer = undefined
}

export function acquireEntry(
	key: string,
	metadata: FileDiffMetadata,
	options: FileDiffOptions<AnnotationMeta>,
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
	const { scrollTop } = $('diff')
	$('diff').replaceChildren(wrapper)
	const canWindow = !currentChanges().some(isBlockSkimCollapsed)
	const inst = canWindow
		? createWindowedDiff(wrapper, options)
		: new FileDiff(options, diffWorkerPool())
	wrapper.dataset.windowed = String(canWindow)
	const entry = { wrapper, inst }
	D.diffCache.set(key, entry)
	$('diff').scrollTop = scrollTop
	return entry
}

function createWindowedDiff(
	wrapper: HTMLElement,
	options: FileDiffOptions<AnnotationMeta>,
): VirtualDiff {
	virtualizer = createVirtualizer(wrapper)
	const instance = new VirtualDiff(
		options,
		virtualizer,
		undefined,
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
	let container = entry.wrapper.querySelector<HTMLElement>(DIFFS_TAG_NAME)
	if (!container) {
		container = document.createElement(DIFFS_TAG_NAME)
		// A cold worker leaves an empty shell for a frame. A zero-height file at y=0 is
		// classified as a bottom anchor by Virtualizer, which jumps to the end on first paint.
		container.style.minHeight = '1px'
		entry.wrapper.appendChild(container)
	}
	entry.inst.render({
		fileDiff: metadata,
		lineAnnotations,
		fileContainer: container,
		containerWrapper: entry.wrapper,
	})
}
