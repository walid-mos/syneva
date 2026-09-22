import type { ReviewState } from '@entities/review/model'
import type { PreviewFile } from '@entities/review/model'
import type { Settings } from '@entities/settings/model'
import type { DiffStyle, Selection } from '@shared/diff-renderer/types'
import type { DiffHolder } from '@widgets/diff-view/runtime'

// The desk page's render context. The page is the one render funnel; it reaches the
// app-owned reactive store and the widget-owned diff runtime only through this seam
// (bound once by app composition) - no page module imports @app.
export interface DeskCtx {
	S: {
		state: ReviewState | null
		settings: Settings
		selected: Selection
		preview: PreviewFile | null
		diffStyle: DiffStyle
		fileIndex: number
		fileView: 'rendered' | 'source'
		rendering: boolean
		composerOpen: boolean
		fileComposerOpen: boolean
		overviewOpen: boolean
		loadedOversized: Set<string>
		foldExpanded: Set<string>
		awaitingAgent: boolean
		// Facade methods the overview page invokes (composed by the app facade modules).
		startGuided?: () => void
		selectFile?: (i: number) => void
		previewFile?: (path: string) => void
	}
	D: DiffHolder
	// The loaded review, enforcing the same precondition as app/store's requireState().
	requireState: () => ReviewState
	// The app funnel's indicator-aware deferred render (see render.ts).
	deferRender: (isForcedIfBig?: boolean) => void
}

let ctx: DeskCtx | null = null

export function bindDeskCtx(bound: DeskCtx): void {
	ctx = bound
}

export function deskCtx(): DeskCtx {
	if (!ctx)
		throw new Error('desk context read before app composition bound it')
	return ctx
}
