import type { ReviewState } from '@entities/review/model'
import type { DiffView } from './diff-key'

// The typed seam between the chrome (pages/desk/render.ts is the one full-pass
// caller today) and the imperative diff island. The engine owns the pixels of
// #diff; it receives everything through DiffModel and never imports the store or
// @app. Engine->chrome state (selection, scroll, composer) flows through diffCtx
// (bound by app composition) rather than an event channel - that path predates the
// seam and an event bus would duplicate it; revisit only if a second consumer of
// the engine appears.
//
// Registered by diff-instance at module scope (same shape as render-scheduler:
// lower layers request through the seam, composition installs the real thing).

type ReviewFile = ReviewState['files'][number]

// Exactly what one engine pass consumes: the current file and the resolved view
// flags (the funnel derives them from the store's settings + expand cap).
export type DiffModel = {
	file: ReviewFile
	view: DiffView
	isCurrent: () => boolean
}

export interface DiffEngine {
	// Bind the surfaces the engine paints into: the diff viewport (#diff, the scroll
	// container) and the overview ruler pane (#ovr). The desk has exactly one of
	// each; the island's leaf modules resolve them through dom.$ until a second
	// host could exist.
	mount(viewport: HTMLElement, ruler: HTMLElement): void
	// Full pass: parse/replay metadata, acquire the wrapper, paint. File switches,
	// content changes and view-flag changes land here.
	applyModel(model: DiffModel): Promise<void>
	// Cheap delta: the mounted wrapper stays; a decision/comment/composer update
	// re-adopts metadata (the library's layout-reset seam) and repaints annotations
	// in place. Returns false when nothing is mounted for this model - the caller
	// falls back to applyModel.
	updateAnnotations(model: DiffModel): boolean
	// Drop the active handles before a replacement view owns the pane.
	clear(): void
	// Session teardown: discard every cached entry and unmount the virtualizers.
	dispose(): void
}

let engine: DiffEngine | null = null

export function registerDiffEngine(registered: DiffEngine): void {
	engine = registered
}

function needEngine(): DiffEngine {
	if (!engine)
		throw new Error('diff engine used before diff-instance registered it')
	return engine
}

export function mountDiffEngine(
	viewport: HTMLElement,
	ruler: HTMLElement,
): void {
	needEngine().mount(viewport, ruler)
}

export function applyDiffModel(model: DiffModel): Promise<void> {
	return needEngine().applyModel(model)
}

// Cheap-delta seam: false means "nothing mounted - run a full pass".
export function updateDiffAnnotations(model: DiffModel): boolean {
	return needEngine().updateAnnotations(model)
}

export function clearDiffEngine(): void {
	needEngine().clear()
}

export function disposeDiffEngine(): void {
	needEngine().dispose()
}
