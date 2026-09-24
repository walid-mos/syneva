import type { ResetScope } from '@contracts/review'
import type { TreeRow } from '@entities/review/file/tree-rows'
import type { WalkRow } from '@entities/review/guide/walkthrough'
import type {
	GuideFile,
	PreviewFile,
	ReviewState,
} from '@entities/review/model'
import type {
	NoteThreadRef,
	NotesLens,
	ReviewNote,
} from '@entities/review/notes'
import type { Settings } from '@entities/settings/model'
import type { DiffStyle, Selection } from '@shared/diff-renderer/types'

// The single reactive store's shape: data fields are the source of truth; the methods
// are attached by the app facade modules for the chrome (React components + keyboard
// dispatcher) to call through the store view (hence optional on the data literal).
export interface Store {
	// The live review, or null before main.ts adopts the initial fetch. Selectors the template can
	// reach that early tolerate null; operations that need a review go through requireState().
	state: ReviewState | null
	projectFiles: string[]
	expandedDirs: Set<string>
	collapsedDirs: Set<string>
	diffStyle: DiffStyle
	fileIndex: number
	// A non-review file (e.g. an unchanged file) the reviewer opened to read/comment on.
	// When set, it's the "current file" instead of state.files[fileIndex].
	preview: PreviewFile | null
	// True while a (non-cached) diff render is in flight - drives the "Rendering…" indicator.
	rendering: boolean
	awaitingAgent: boolean
	// Transient desk-liveness from /api/state (DeskStatus fields). Held OUTSIDE
	// S.state so they never ride a /api/save round-trip into the persisted review.
	agentActivity: string | null
	agentListening: boolean
	queuedQuestions: number
	queuedReviews: number
	lastBaseDiffHash: string | null
	// Persistent, non-destructive notice: a restarted desk may require a different UI bundle.
	isRefreshRequired: boolean
	// The desk stopped (the browser Close action, or it's simply gone and the polls stopped
	// answering). One-way for the tab: a full-surface cover replaces the workspace.
	deskClosed: boolean
	selected: Selection
	// An inline composer (new / reply / edit) is open. Exactly one at a time; the composer's
	// text lives in composerBody so it survives the diff DOM rebuild (see composer.ts).
	// composerOpen is the LINE composer's flag; fileComposerOpen its whole-file twin (the file
	// header's comment icon). The open helpers keep the pair mutually exclusive.
	composerOpen: boolean
	fileComposerOpen: boolean
	toastMsg: string
	// Pending "go to line" digits typed in the diff ("" = inactive). Drives the goline pill;
	// ↵ / idle timeout commits the jump, Esc cancels (see cursor.ts goline section).
	golineBuffer: string
	composerBody: string
	editingCommentId: string | null
	settings: Settings
	settingsOpen: boolean
	// Which tab the settings modal shows ("shortcuts" = the keyboard map). A small confirm dialog
	// backs the destructive shortcuts (⇧R / ⇧S / ⇧Q); confirmMsg is the prompt text, "" when closed.
	settingsTab: 'settings' | 'shortcuts'
	confirmMsg: string
	// The Send modal (⇧S / Send button): a receipt (sendMsg) plus an optional overall note the
	// reviewer types for the agent. sendOpen toggles it; sendNote is ephemeral (cleared each open,
	// never persisted). ⌘↵ sends, Enter is a newline, Esc cancels.
	sendOpen: boolean
	sendMsg: string
	sendNote: string
	// Confirm-first gate for the browser Close (the header button and ⇧Q both route through it).
	confirmClose?: () => void
	// Guided review: when true (and a guide is attached) the center shows the Overview page
	// instead of the diff. Selecting any file (tree or Start) drops back to the diff.
	overviewOpen: boolean
	// Which sidebar pane is showing when a guide is attached (no guide → tabs hidden, tree
	// only). Per-session like overviewOpen; settings.sidebarDefault seeds it at init.
	sidebarTab: 'tree' | 'walkthrough'
	// Narrow widths (≤1100px): the file tree is an off-canvas left drawer, hidden by default so
	// the diff owns the screen. Toggled by the header hamburger / ⇧B; auto-closed on file select.
	// Inert on desktop - the drawer styles are media-gated, so the tree stays side-by-side there.
	treeDrawerOpen: boolean
	// file mode: how a markdown file is shown - "rendered" (comark/markdown-it preview,
	// comment on blocks) or "source" (@pierre/diffs raw/diff).
	fileView: 'rendered' | 'source'
	// True once the diff pane is scrolled past its header - reveals the floating Approve button
	// so sign-off is reachable without scrolling back up to the header. Reset on every file switch.
	diffScrolled: boolean
	// Per-session expand state of the two collapsible trailing sidebar groups (Renamed, and
	// Reviewed under the hide-reviewed pref), keyed `group:<name>`. Not persisted - folding is
	// display-only and resets each session.
	foldExpanded: Set<string>
	// Paths of oversized files the reviewer chose to "Load diff anyway" on (issue 05). Once loaded,
	// a file renders its real diff for the rest of the session instead of the summary card. Per-
	// session and never persisted - the oversized stamp is server-owned and re-derived on reload.
	loadedOversized: Set<string>
	// The review-notes panel (right side): every comment/question thread of the whole review,
	// one click from any file. Per-session like the other chrome flags - never persisted.
	notesOpen: boolean
	// The panel's working state (per-session like notesOpen): the filter query, the status
	// lens, and the keyboard cursor - an index into the panel's flat visible rows (questions
	// then comments; see notesPanelView, the one derivation the cursor and the render share).
	notesQuery: string
	notesLens: NotesLens
	notesCursor: number
	// A focus pulse: the '/' hotkey bumps it, the panel's effect focuses the filter box.
	// A tick instead of a boolean so repeating '/' refocuses even after the field kept focus.
	notesSearchTick: number
	// The resolve-approve flow's armed state: a thread resolved on a not-yet-signed-off file
	// while the panel is open waits for THAT file's sign-off, and the advance then goes to
	// the panel's next unresolved thread instead of the next file. `pos` is the thread's
	// index in the panel's flat visible rows at resolve time - the post-resolve scan starts
	// there, which stays correct whether the lens keeps the resolved row or drops it.
	notesAdvanceAfter: { ref: NoteThreadRef; pos: number } | null

	treeRows?: () => TreeRow[]
	selectFile?: (i: number) => void
	previewFile?: (path: string) => void
	toggleDir?: (full: string, changed: boolean) => void
	toggleAllDirs?: () => void
	treeAnyOpen?: () => boolean
	toggleTestDir?: (key: string) => void
	toggleRenamedGroup?: () => void
	toggleReviewedGroup?: () => void
	rowClick?: (r: TreeRow) => void
	setStyle?: (style: DiffStyle) => void
	setFileView?: (view: 'rendered' | 'source') => void
	isMarkdownFile?: () => boolean
	// Sign off on the current file from the floating button (same action as the header ⇧A).
	approveFile?: () => void
	// The hide-reviewed lens (multi-round reviews): hide accepted change bands in the diff
	// (render/distill) and fold fully-approved files out of the sidebars (flow-index). The
	// pref persists; hasReviewed gates the header toggle (nothing to distill on first sight).
	hasReviewed?: () => boolean
	toggleHideReviewed?: () => void
	// Drives the floating Approve button: null hides it (overview, preview, or finished file),
	// else the pending file's sign-off flavor - "clean" (Approve) or "changes" (Mark Reviewed).
	fabState?: () => 'clean' | 'changes' | null
	splitApplies?: () => boolean
	applySettings?: () => void
	openInEditor?: () => Promise<void>
	openSettings?: () => void
	closeSettings?: () => void
	hasGuide?: () => boolean
	guideStale?: () => boolean
	openOverview?: () => void
	startGuided?: () => void
	showGuideBar?: () => boolean
	curGuide?: () => GuideFile | null
	curFileName?: () => string
	guideNext?: () => void
	guidePrev?: () => void
	guideAtStart?: () => boolean
	guideAtLast?: () => boolean
	walkthroughRows?: () => WalkRow[]
	saveComment?: () => void
	ask?: () => void
	requestChange?: () => void
	reset?: (scope: ResetScope) => Promise<void>
	// The Reset split button's dropdown (approved-only / all). Store-owned so the React chrome
	// and the Esc cascade agree on it; per-session, never persisted.
	resetMenuOpen?: boolean
	setResetMenu?: (open: boolean) => void
	send?: (overallNote?: string) => Promise<void>
	// The browser Close: confirm, flush the coalescing saver, stop the desk via /api/shutdown,
	// then show the closed cover (window.close() after it usually can't script-close an
	// OS-opened tab). Also driven implicitly when the polls stop answering (poll.ts).
	closeDesk?: () => Promise<void>
	// The whole-file (file header) composer: toggled by the guide bar's / file header's comment
	// icon; the count feeds the icon badge, the availability gate hides it on the Overview page
	// and single-file desks.
	toggleFileComposer?: () => void
	openFileCommentCount?: () => number
	fileCommentAvailable?: () => boolean
	// The notes panel: topbar/keyboard toggle, and jumping to a note - same-file notes land
	// immediately, other-file notes funnel through S.selectFile/S.previewFile plus a pending
	// jump the render consumes once the target file is on screen (see facade/notes.ts).
	toggleNotes?: () => void
	jumpToNote?: (note: ReviewNote) => void
	// The panel's cursor: move it (↑/↓), jump to the note under it (↵), focus the filter
	// box ('/'). setNotesQuery/setNotesLens restart the cursor at the top - a new view is
	// a new list. Cursor moves and jumps derive the visible rows through notesPanelView,
	// never from the component's render.
	setNotesQuery?: (query: string) => void
	setNotesLens?: (lens: NotesLens) => void
	notesCursorMove?: (dir: 1 | -1) => void
	notesJumpCursor?: () => void
	notesFocusSearch?: () => void
	// Resolve side: the resolve entry points report the thread (pre-status-flip). The facade
	// either schedules the immediate advance (file already signed off) or arms the flow.
	noteResolved?: (ref: NoteThreadRef) => void
	// Sign-off side: approveCurrentFile's advance asks here first; true means it jumped to
	// the armed flow's next note, false means nothing was armed for that path.
	notesAfterSignOff?: (path: string) => boolean
	// Keyboard navigation (keys.ts): file stepping in either mode, confirm-dialog answers, and the
	// grouped binding list the help overlay renders.
	nextFile?: () => void
	prevFile?: () => void
	// The one next/prev step, in the ACTIVE pane's sorting (tree order / walkthrough order;
	// see navigate.ts) - the keyboard keys and the guide-bar buttons share it, and the
	// sign-off advance falls back to it.
	stepInView?: (dir: 1 | -1) => void
	// approveCurrentFile's advance: the notes flow first, else stepInView(1).
	afterSignOff?: (path: string) => void
	treeStep?: (dir: 1 | -1) => void
	confirmYes?: () => void
	confirmNo?: () => void
	promptFinish?: () => void
	confirmSend?: () => void
	sendConfirm?: () => void
	sendCancel?: () => void
	helpGroups?: () => {
		group: string
		items: { combo: string; desc: string }[]
	}[]
}
