import type { TreeRow } from '@entities/review/file/tree-rows'
import type { WalkRow } from '@entities/review/guide/walkthrough'
import type { ReviewNote } from '@entities/review/notes'
import type { PreviewFile, ReviewState } from '@entities/review/model'
import type { GuideFile } from '@entities/review/model'
import type { Settings } from '@entities/settings/model'
import type { DiffStyle } from '@shared/diff-renderer/types'

// The chrome widgets' view context (progress strip, sidebar highlight, dialogs, modals).
// Chrome reaches the app-owned reactive store only through this seam (bound once by app
// composition) - no chrome module imports @app. The React chrome components read the same
// view; re-render comes from the store-version subscription (shared/lib/use-store-version).
export interface ChromeStoreView {
	state: ReviewState | null
	settings: Settings
	fileIndex: number
	foldExpanded: Set<string>
	preview: PreviewFile | null
	overviewOpen: boolean
	rendering: boolean
	awaitingAgent: boolean
	// Polling stores the activity line as a plain string (see app/poll.ts adoptLiveness);
	// the widget view mirrors that representation, not the DeskStatus object.
	agentActivity: string | null
	agentListening: boolean
	queuedQuestions: number
	queuedReviews: number
	lastBaseDiffHash: string | null
	deskClosed: boolean
	isRefreshRequired: boolean
	diffStyle: DiffStyle
	composerOpen: boolean
	fileComposerOpen: boolean
	toastMsg: string
	golineBuffer: string
	composerBody: string
	editingCommentId: string | null
	// The review-notes panel's working state (per-session like the other chrome flags,
	// never persisted): the filter query, the status lens, the keyboard cursor, the '/'
	// focus pulse. See notes-panel.tsx and entities/review/notes.ts for the derivation.
	notesOpen: boolean
	notesQuery: string
	notesLens: 'all' | 'open' | 'resolved'
	notesCursor: number
	notesSearchTick: number
	settingsOpen: boolean
	settingsTab: 'settings' | 'shortcuts'
	confirmMsg: string
	sendOpen: boolean
	sendMsg: string
	sendNote: string
	sidebarTab: 'tree' | 'walkthrough'
	treeDrawerOpen: boolean
	fileView: 'rendered' | 'source'
	diffScrolled: boolean

	// The store methods the chrome calls (attached by the app facade modules before
	// the React tree mounts, so the first render already sees them).
	treeRows?(): TreeRow[]
	selectFile?(i: number): void
	previewFile?(path: string): void
	toggleDir?(full: string, changed: boolean): void
	toggleAllDirs?(): void
	treeAnyOpen?(): boolean
	toggleTestDir?(key: string): void
	toggleRenamedGroup?(): void
	toggleReviewedGroup?(): void
	rowClick?(r: TreeRow): void
	setStyle?(style: DiffStyle): void
	setFileView?(view: 'rendered' | 'source'): void
	isMarkdownFile?(): boolean
	approveFile?(): void
	hasReviewed?(): boolean
	toggleHideReviewed?(): void
	fabState?(): 'clean' | 'changes' | null
	applySettings?(): void
	openSettings?(): void
	closeSettings?(): void
	hasGuide?(): boolean
	guideStale?(): boolean
	openOverview?(): void
	startGuided?(): void
	showGuideBar?(): boolean
	curGuide?(): GuideFile | null
	curFileName?(): string
	guideNext?(): void
	guidePrev?(): void
	guideAtStart?(): boolean
	guideAtLast?(): boolean
	walkthroughRows?(): WalkRow[]
	// The notes panel: open/close, jump to a thread, and its working-state setters.
	toggleNotes?(): void
	jumpToNote?(note: ReviewNote): void
	setNotesQuery?(query: string): void
	setNotesLens?(lens: 'all' | 'open' | 'resolved'): void
	notesCursorMove?(dir: 1 | -1): void
	notesJumpCursor?(): void
	saveComment?(): void
	ask?(): void
	requestChange?(): void
	reset?(): Promise<void>
	send?(overallNote?: string): Promise<void>
	closeDesk?(): Promise<void>
	toggleFileComposer?(): void
	openFileCommentCount?(): number
	fileCommentAvailable?(): boolean
	confirmYes?(): void
	confirmNo?(): void
	confirmSend?(): void
	sendConfirm?(): void
	sendCancel?(): void
	helpGroups?(): {
		group: string
		items: { combo: string; desc: string }[]
	}[]
}

let ctx: { S: ChromeStoreView } | null = null

export function bindChromeCtx(bound: ChromeStoreView): void {
	ctx = { S: bound }
}

export function chromeCtx(): { S: ChromeStoreView } {
	if (!ctx)
		throw new Error('chrome context read before app composition bound it')
	return ctx
}
