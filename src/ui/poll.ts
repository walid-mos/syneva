import { updateAwaitingDom } from './awaiting'
import { render } from './render'
import { api, D, S, saver, toast } from './store'

import type {
	DeskStatus,
	BrowserRefreshEvent,
	PollPayload,
	ReviewComment,
	ReviewState,
} from './types'

// A server payload with the transient DeskStatus fields still attached. `Partial` because the
// desk's own routes may answer without them (there is nothing live to report).
export type StateWithStatus = ReviewState &
	Partial<DeskStatus> & { serverInstanceId?: string }
export type PollWithStatus = PollPayload & Partial<DeskStatus>

// How often the tab polls the desk. The tick carries liveness, the guide, the comments and the
// diff's hash - everything small enough to re-read continuously.
export const POLL_INTERVAL_MS = 1500

let serverInstanceId: string | undefined

// Check every response that can replace browser state, including Reset. A notification is safer
// than automatic navigation: stage/unstage/Send can still be in flight after their dialogs close.
export function isCurrentDesk(instance: string | undefined): boolean {
	if (!serverInstanceId || instance === serverInstanceId) return true
	S.isRefreshRequired = true
	return false
}

// Move the transient DeskStatus fields off a server payload into the store. They must never enter
// S.state: persist() posts S.state back to /api/save, and the persisted review must not carry desk
// liveness.
function adoptLiveness(status: Partial<DeskStatus>): void {
	S.agentActivity = status.agentActivity?.body ?? null
	S.agentListening = status.agentListening ?? false
	S.queuedQuestions = status.queuedQuestions ?? 0
	S.queuedReviews = status.queuedReviews ?? 0
}

export function adoptDeskStatus(payload: StateWithStatus): ReviewState {
	const {
		agentActivity,
		agentListening,
		queuedQuestions,
		queuedReviews,
		serverInstanceId: instance,
		...review
	} = payload
	serverInstanceId ??= instance
	adoptLiveness({
		agentActivity,
		agentListening,
		queuedQuestions,
		queuedReviews,
	})
	return review
}

function adoptPollStatus(payload: PollWithStatus): PollPayload {
	const {
		agentActivity,
		agentListening,
		queuedQuestions,
		queuedReviews,
		...lite
	} = payload
	adoptLiveness({
		agentActivity,
		agentListening,
		queuedQuestions,
		queuedReviews,
	})
	return lite
}

// One poll tick's payload, with liveness already adopted and patched into the waiting indicators.
// null when the desk is unreachable or answered something that isn't a poll payload.
async function pollOnce(): Promise<PollPayload | BrowserRefreshEvent | null> {
	try {
		const query = serverInstanceId
			? `?instance=${encodeURIComponent(serverInstanceId)}`
			: ''
		const payload = await api<
			PollWithStatus | (BrowserRefreshEvent & Partial<DeskStatus>)
		>(`/api/poll${query}`)
		if ('kind' in payload) {
			adoptLiveness(payload)
			updateAwaitingDom()
			return payload
		}
		if (!Array.isArray(payload.comments)) return null
		const lite = adoptPollStatus(payload)
		// Activity/presence changes alone don't warrant a render - patch the waiting indicators in
		// place every tick.
		updateAwaitingDom()
		return lite
	} catch {
		return null
	}
}

// Fetch the browser projection only when the diff changes, not on every heartbeat.
async function loadReviewState(): Promise<ReviewState | null> {
	try {
		const payload = await api<StateWithStatus>('/api/state')
		if (!isCurrentDesk(payload.serverInstanceId)) return null
		const server = adoptDeskStatus(payload)
		if (!Array.isArray(server.comments)) return null
		return server
	} catch {
		return null
	}
}

// Replace the live review with a freshly loaded one, keeping the reviewer on the same file. File
// order/membership can change (the agent added, removed, or reordered files), so re-find the
// current path in the new list rather than trusting the numeric index - otherwise the shown file,
// and guided auto-advance (which resolves "next" from the current index), silently jump to
// whatever now sits there.
function adoptReloadedState(server: ReviewState): void {
	const curPath = S.state?.files[S.fileIndex]?.path
	S.state = server
	D.fileDiff = null
	const remapped = curPath
		? server.files.findIndex(f => f.path === curPath)
		: -1
	if (remapped >= 0) S.fileIndex = remapped
	else if (S.fileIndex >= server.files.length) S.fileIndex = 0
}

// The diff changed (e.g. a reload added files) - refresh the project listing too so the tree
// reflects newly tracked files, not the listing fetched at startup. The listing is chrome: a
// failed refresh leaves the previous one in place.
async function refreshProjectFiles(): Promise<void> {
	try {
		const tree = await api<{ files?: string[] }>('/api/tree')
		if (tree.files) S.projectFiles = tree.files
	} catch {
		// keep the listing we already have
	}
}

// Adopt a swapped guide. A reload can regenerate one without changing the diff, so this is
// checked on every tick; guides are small, so the compare is cheap.
function adoptGuide(lite: PollPayload): boolean {
	const { state } = S
	if (!state) return false
	if (
		JSON.stringify(lite.guide ?? null) ===
		JSON.stringify(state.guide ?? null)
	)
		return false
	state.guide = lite.guide
	return true
}

// Merge comments the tab doesn't have yet (an agent reply, another tab's comment). Additive by
// design: removals only ever arrive with a full state adopt.
function adoptIncomingComments(comments: ReviewComment[]): boolean {
	const { state } = S
	if (!state) return false
	const localIds = new Set(state.comments.map(c => c.id))
	const incoming = comments.filter(c => !localIds.has(c.id))
	if (!incoming.length) return false
	state.comments.push(...incoming)
	if (incoming.some(c => c.role === 'agent')) {
		S.awaitingAgent = false
		toast('Agent replied')
	}
	return true
}

// The reload path: the diff's hash moved, so (and only then) pull the full state.
async function adoptReload(): Promise<void> {
	const server = await loadReviewState()
	if (!server) return
	S.lastBaseDiffHash = server.baseDiffHash
	adoptReloadedState(server)
	S.awaitingAgent = false
	await refreshProjectFiles()
	void render()
	toast('Diff updated')
}

// The heartbeat carries hash + guide + comments + liveness, or a refresh event after a restart.
// Fetch the browser review only when baseDiffHash moves; never poll its file/change arrays.
export async function pollState(): Promise<void> {
	const lite = await pollOnce()
	if (!lite) return
	if ('kind' in lite) {
		S.isRefreshRequired = true
		return
	}
	if (lite.baseDiffHash !== S.lastBaseDiffHash) {
		// The reload branch replaces S.state wholesale and re-renders, which would clobber local
		// decisions/comments not yet persisted and rebuild the diff DOM out from under an open
		// composer (losing in-progress typing). Defer while a save is busy OR a composer is open -
		// S.lastBaseDiffHash stays put, and the next tick re-detects the changed hash and adopts
		// once the save has drained and the composer has closed. This only narrows a race that
		// already existed (fire-and-forget persist could lose the same way). Scoping the composer
		// guard here (not at the top) keeps liveness/presence and the additive agent-reply comment
		// merge running every tick while a reply box is open, so the desk never looks dead.
		if (saver.isBusy() || S.composerOpen || S.fileComposerOpen) return
		await adoptReload()
		return
	}
	const guideChanged = adoptGuide(lite)
	const commentsChanged = adoptIncomingComments(lite.comments)
	if (guideChanged) toast('Guide updated')
	if (guideChanged || commentsChanged) void render()
}
