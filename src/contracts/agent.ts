// The agent-facing event/result DTOs - protocol shapes only. A neutral dependency
// sink like the rest of src/contracts: imports only the shared review records, no
// backend/frontend modules, no platform API.
import type { ReviewMode } from './review.js'

// The structured payload printed to stdout (and written to result.json) when
// the reviewer clicks "Send to agent". This is the handoff contract.
export type ReviewResult = {
	session: string
	repoRoot: string
	mode: ReviewMode
	target?: string
	base?: string
	staged: boolean
	head: string | null
	baseDiffHash: string
	accepted: Array<{
		path: string
		lineNumber: number
		side: string
		title: string
	}>
	rejected: Array<{
		path: string
		lineNumber: number
		side: string
		title: string
	}>
	requestedChanges: Array<{
		path: string
		lineNumber: number
		side: string
		body: string
		// "file" on a whole-file request (the file-header comment): no line to edit - apply the
		// remark to the file as a whole. Absent on a line-anchored request.
		anchor?: 'file'
	}>
	// An optional note the reviewer attached at Send time about the whole review - an overall
	// remark, or an afterthought instruction for what to do after applying it. Ephemeral: captured
	// per Send, never persisted into the review state, so a one-off instruction can't silently
	// re-send.
	overallNote?: string
	stagedFiles: readonly string[]
	// Files the reviewer signed off as-is (no rejected hunks, no open requested-change
	// comments, approval still current): the agent should leave these unchanged.
	approvedFiles: string[]
	// Questions still unanswered when the reviewer hit Send - folded into the round so an
	// agent that missed the live await still owes an answer. Every open question comment
	// (intent "question", no later agent reply in its thread), same shape as an await
	// question. Answer each via `syneva comment`; answering stays read-only - edits come
	// only from the round's requested changes.
	openQuestions: QuestionPayload[]
	artifacts: { resultJson: string; sessionDir: string }
}

// A question the reviewer asked (intent "question") that the agent should answer now.
export type QuestionPayload = {
	path: string
	lineNumber: number
	side: 'additions' | 'deletions'
	body: string
	// "file" on a whole-file question (reviewer asked from the file header): reply with
	// `syneva comment --path <f> --line 0` so the answer threads into that file header.
	anchor?: 'file'
	mode: ReviewMode
	session: string
}

// What `syneva await` yields - a tagged event stream. The agent loops and branches:
// "question" → answer it now with `syneva comment`; "review" → act on the Send;
// "closed" → the human ended the review from the browser (the desk's Close action).
export type AwaitEvent =
	| { kind: 'review'; result: ReviewResult }
	// `question` is the oldest of the batch (kept for compatibility); `questions` carries every
	// question delivered together, arrival order - a reviewer can fire several before the agent
	// comes back, so one await hands them all over. Answer each. A lone question arrives as a
	// one-element `questions`, so consumers can always read the array uniformly.
	| {
			kind: 'question'
			question: QuestionPayload
			questions: QuestionPayload[]
	  }
	// The reviewer closed the desk (browser Close): the review flow is over. Every Sends not
	// picked up live survive as artifacts.resultJson (the file-poll fallback); all review state
	// is saved and a later start restores the session. Emitted just before the desk exits so a
	// parked waiter learns why instead of watching the socket die.
	| { kind: 'closed'; session: string }
