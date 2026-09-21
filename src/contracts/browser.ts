// The browser's projection of a review - protocol DTOs only. A neutral dependency
// sink like the rest of src/contracts: imports only the shared review records,
// no backend/frontend modules, no platform API.
//
// The browser receives metadata, not the backend's diff bodies. This is the explicit
// allowlist: newly added backend fields on ReviewFile/ReviewState stay private until
// picked here. The renderer builds its own hunks from /api/file-contents. (Mirror of
// the backend's ReviewFile projection - see src/backend/domain/review.ts.)
import type {
	ChangeState,
	Decision,
	Guide,
	ReviewComment,
	ReviewMode,
} from './review.js'

export type BrowserReviewFile = {
	path: string
	oldPath?: string
	newPath?: string
	contentHash: string
	changeKind?: 'added' | 'modified' | 'deleted' | 'renamed'
	renamePure?: boolean
	oversized?: boolean
	size?: number
	added: number
	removed: number
	hasHunks: boolean
}

export type BrowserReviewState = {
	root: string
	session: string
	mode: ReviewMode
	target?: string
	staged: boolean
	baseDiffHash: string
	changes: readonly ChangeState[]
	comments: readonly ReviewComment[]
	decisions?: readonly Decision[]
	guide?: Guide
	reviewedFiles: readonly string[]
	reviewedFileHashes?: Readonly<Record<string, string>>
	stagedFiles: readonly string[]
	stagedChangeKeys?: readonly string[]
	decisionFiles?: readonly string[]
	files: readonly BrowserReviewFile[]
}

// A process change asks the tab to refresh its bundle before adopting another server's state.
// This is a browser heartbeat event, not an agent-facing AwaitEvent.
export type BrowserRefreshEvent = { kind: 'refresh' }
export type BrowserResetResponse = {
	ok: true
	state: BrowserReviewState
	serverInstanceId: string
}

// The reviewer-owned slice the browser posts to /api/save. Only these fields are mutated
// from the tab; everything else on the review state (rawDiff, file contents, changes, guide,
// mode params, hashes) is server/agent-owned and stays authoritative on the server - so
// the save wire carries this slice instead of the whole (multi-MB) state. The server
// replaces exactly these fields (snapshot semantics, latest wins) and touches nothing else.
// decisionFiles rides along because it's reviewer-mutated and gates the per-file Reset
// button on reload; stagedFiles/stagedChangeKeys deliberately do NOT - they're maintained
// server-side by /api/stage, /api/unstage, and readStagedSnapshot (backend/application/reconcile.ts).
export type ReviewerSave = Pick<
	BrowserReviewState,
	| 'decisions'
	| 'comments'
	| 'reviewedFiles'
	| 'reviewedFileHashes'
	| 'decisionFiles'
>

// Transient desk-liveness fields alongside BrowserReviewState. Never persist these or include
// them in ReviewerSave: they describe the live desk process, not the durable review.
export type AgentActivity = { body: string; at: string }
export type DeskStatus = {
	// Latest `syneva status` line, or null when none posted or stale (past the TTL).
	agentActivity: AgentActivity | null
	// An await long-poll is parked right now - something is listening for events.
	agentListening: boolean
	// Events emitted with no waiter parked sit in the queue undelivered; a non-zero
	// count means "asked/sent, but nothing picked it up yet".
	queuedQuestions: number
	queuedReviews: number
}

// One file's old/new contents, fetched on demand by the tab (GET /api/file-contents) so the full
// contents never ride /api/state - the state itself is lean (issue 04 removed the embedded copies).
// The server resolves these from git/the working tree. The tab caches the payload keyed by path +
// the file's contentHash (which changes on reload, invalidating naturally). oldOid/newOid are the
// blob OIDs of each side (newOid === the file's contentHash); carried for a future client-side
// content cache, unused by the tab today.
export type FileContentsPayload = {
	path: string
	oldContents: string
	newContents: string
	oldOid: string
	newOid: string
}

// The tab's 1.5s heartbeat (GET /api/poll): just enough to detect change. File summaries and change
// records belong on /api/state, fetched on baseDiffHash changes, not on every tick. A mismatched
// ?instance= from an older desk process receives BrowserRefreshEvent instead. DeskStatus rides both.
export type PollPayload = Pick<
	BrowserReviewState,
	'baseDiffHash' | 'guide' | 'comments'
>
