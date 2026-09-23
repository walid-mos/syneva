import type { PreviewFile, ReviewState } from '@entities/review/model'
import type { Settings } from '@entities/settings/model'
import type { DiffStyle, Selection, Side } from '@shared/diff-renderer/types'
import type { DiffHolder } from './runtime'

// The view context the imperative diff island renders against. Widgets reach the app-owned
// reactive store only through this seam (bound once by app composition, mirroring the
// render-scheduler pattern) - no widget module imports @app. The bound object must be the
// Alpine reactive proxy itself, so mutations stay observable; D stays the plain holder
// (an Alpine Proxy breaks @pierre's element-identity checks).
export interface DiffStoreView {
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
	composerBody: string
	editingCommentId: string | null
	overviewOpen: boolean
	expandedDirs: Set<string>
	collapsedDirs: Set<string>
	golineBuffer: string
	loadedOversized: Set<string>
	foldExpanded: Set<string>
	awaitingAgent: boolean
	// Polling stores the activity line as a plain string (see app/poll.ts adoptLiveness);
	// the widget view mirrors that representation, not the DeskStatus object.
	agentActivity: string | null
	diffScrolled: boolean
	toastMsg: string
	projectFiles: string[]
	queuedQuestions: number
	queuedReviews: number
	lastBaseDiffHash: string | null
	deskClosed?: boolean
	isRefreshRequired?: boolean
	// Facade methods the chrome composes into the store (see app/facade/*).
	setStyle?: (style: DiffStyle) => void
	openInEditor?: () => Promise<void>
	toggleFileComposer?: () => void
	// The notes flow's resolve hook (facade/notes): the resolve entry points report the
	// thread pre-flip so the panel can arm or fire its advance (see notes-panel flow).
	noteResolved?: (ref: {
		path: string
		side: Side
		lineNumber: number
		fileLevel: boolean
	}) => void
}

export interface DiffServices {
	// The app funnel's indicator-aware deferred render (see pages/desk/render.ts).
	deferRender: (isForcedIfBig?: boolean) => void
	// Auto-save trigger - every state mutation must call it (see app/store.ts).
	persist: () => void
	toast: (message: string) => void
}

export interface DiffCtx {
	S: DiffStoreView
	D: DiffHolder
	// The loaded review, enforcing the same precondition as app/store's requireState().
	requireState: () => ReviewState
}

let ctx: (DiffCtx & DiffServices) | null = null

export function bindDiffCtx(bound: DiffCtx & DiffServices): void {
	ctx = bound
}

export function diffCtx(): DiffCtx & DiffServices {
	if (!ctx)
		throw new Error(
			'diff view context read before app composition bound it',
		)
	return ctx
}
