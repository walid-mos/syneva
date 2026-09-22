import { saveReview } from '@entities/review/api'
import { createSaver, reviewerSlice } from '@entities/review/save'
import { loadSettings } from '@entities/settings/settings'
import AlpineJS from 'alpinejs'

import type { ReviewState } from '@entities/review/model'
import type { Store } from './store-state'

// How long a toast stays up before it clears itself.
const TOAST_MS = 2800

// Single reactive source of truth: the imperative diff island mutates it directly,
// and the Alpine-driven chrome (tree, toolbar, composer, modals, toast) renders from it.
// `state` is null until the initial fetch in main.ts adopts it; the selectors that the template
// can reach before then (treeRows, hasGuide, ...) tolerate null, and every operation that needs a
// loaded review goes through requireState() below.
export const S: Store = AlpineJS.reactive<Store>({
	state: null,
	projectFiles: [],
	expandedDirs: new Set<string>(),
	collapsedDirs: new Set<string>(),
	// Display preferences come from ~/.syneva/settings.json (fetched in main.ts init),
	// not localStorage - origins change with the random port, files don't.
	diffStyle: 'split',
	fileIndex: 0,
	preview: null,
	rendering: false,
	awaitingAgent: false,
	agentActivity: null,
	agentListening: false,
	queuedQuestions: 0,
	queuedReviews: 0,
	lastBaseDiffHash: null,
	isRefreshRequired: false,
	// The desk stopped (the browser Close action, or it's simply gone and the polls stopped
	// answering). One-way for the tab: a cover replaces the work surface. Polling continues,
	// so a same-origin restart can still propose refresh via isRefreshRequired.
	deskClosed: false,
	selected: { side: 'additions', lineNumber: 1 },
	// chrome UI flags (templates bind to these)
	composerOpen: false,
	fileComposerOpen: false,
	toastMsg: '',
	golineBuffer: '',
	composerBody: '',
	editingCommentId: null,
	settings: loadSettings(),
	settingsOpen: false,
	settingsTab: 'settings',
	confirmMsg: '',
	sendOpen: false,
	sendMsg: '',
	sendNote: '',
	overviewOpen: false,
	sidebarTab: 'tree',
	treeDrawerOpen: false,
	fileView: 'rendered',
	diffScrolled: false,
	foldExpanded: new Set<string>(),
	loadedOversized: new Set<string>(),
})

// The loaded review, for the operations that mutate or render it - all of which run after main.ts
// adopts the initial fetch. Enforces its own precondition instead of handing out a half-built state:
// a read that somehow races the fetch fails here, with the cause named.
export function requireState(): ReviewState {
	const { state } = S
	if (!state) throw new Error('review state read before the first fetch')
	return state
}

// The chrome's element lookup. Every id comes from index.html, which ships with the bundle, so a
// missing element is a bug in the page rather than a runtime condition to branch on.
export function $(id: string): HTMLElement {
	const el = document.getElementById(id)
	if (!el) throw new Error(`missing element #${id}`)
	return el
}
export function show(e: Element): void {
	e.classList.add('show')
}
export function hide(e: Element): void {
	e.classList.remove('show')
}
let toastTimer: ReturnType<typeof setTimeout>
export function toast(t: string): void {
	S.toastMsg = t
	clearTimeout(toastTimer)
	toastTimer = setTimeout(() => {
		S.toastMsg = ''
	}, TOAST_MS)
}

// Post only the reviewer-owned slice (see save.ts) - never the whole (multi-MB) ReviewState.
// Saves coalesce so rapid approvals don't saturate connections.
export const saver = createSaver(
	() => reviewerSlice(requireState()),
	payload => saveReview(payload),
)
// Instant auto-save: there is no manual Save button, so every state mutation
// (decision, comment, stage/unstage, approval) MUST call persist() to write the
// review to ~/.syneva/<repoHash>/<session>/. Saves coalesce (see save.ts): at most one
// in flight, rapid triggers collapse into a single trailing save.
export const persist = (): void => saver.trigger()
