import type { PreviewFile, ReviewState } from '@entities/review/model'
import type { Settings } from '@entities/settings/model'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { LineMap } from '@shared/diff-renderer/linemap'
import type { DiffStyle, Selection } from '@shared/diff-renderer/types'
import type { Side } from '@shared/diff-renderer/types'

// The use-case context: feature actions receive narrow dependencies (review access,
// persist, notify, the imperative island's bits they need) instead of importing the app
// store. Bound once by app composition; no feature module imports @app. This module is
// the features layer's own seam (like shared/lib/render-scheduler), not a slice internal -
// every feature slice reads it, so it stays importable across slices by design.
export interface FeatureStoreView {
	state: ReviewState | null
	settings: Settings
	selected: Selection
	preview: PreviewFile | null
	fileIndex: number
	diffStyle: DiffStyle
	composerOpen: boolean
	fileComposerOpen: boolean
	composerBody: string
	editingCommentId: string | null
	overviewOpen: boolean
	fileView: 'rendered' | 'source'
	awaitingAgent: boolean
	lastBaseDiffHash: string | null
	projectFiles: string[]
	golineBuffer: string
	foldExpanded: Set<string>
	// Facade methods features invoke directly (composed by the app facade modules).
	promptFinish?: () => void
	selectFile?: (i: number) => void
	// The sign-off advance (installed by app/facade/navigate): notes flow first, else the
	// active pane's plain next.
	afterSignOff?: (path: string) => void
	ask?: () => void
	requestChange?: () => void
	saveComment?: () => void
}

export interface FeatureServices {
	// The reactive store view (the Alpine proxy itself) - feature actions read and mutate it.
	S: FeatureStoreView
	requireState: () => ReviewState
	persist: () => void
	toast: (message: string) => void
	// The imperative island's read-only bits features act on. expandHunk/reveal are
	// structurally narrowed here - @pierre's nominal instance never crosses as a type.
	fileDiff: () => FileDiffMetadata | null
	lineMap: () => LineMap | null
	diffInstance: () => {
		options: { expandUnchanged?: boolean }
		expandHunk: (
			regionIndex: number,
			direction: 'up' | 'down',
			lines: number,
		) => unknown
	} | null
	// The keyboard cursor lives in the imperative diff island (widgets/diff-view/cursor.ts);
	// features reach it through these two bound ports instead of importing the widget module.
	cursorSyncTo: (side: Side, line: number) => void
	cursorSelection: () => { side: Side; lineNumber: number } | null
}

// The context features read: the store view rides inside FeatureServices as `S` (feature
// actions go through ctx.S.*), so the bound object is the services plus that one view.
export type FeatureCtx = FeatureServices

let ctx: FeatureCtx | null = null

export function bindFeatureCtx(bound: FeatureCtx): void {
	ctx = bound
}

export function featureCtx(): FeatureCtx {
	if (!ctx)
		throw new Error('feature context read before app composition bound it')
	return ctx
}
