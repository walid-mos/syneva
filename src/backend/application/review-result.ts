import { commentAnchor } from '../domain/comments.js'
import {
	computeApprovedFiles,
	effectiveDecisions,
} from '../domain/decisions.js'

import type { QuestionPayload, ReviewResult } from '../../contracts/agent.js'
import type { Decision, ReviewComment, ReviewState } from '../domain/review.js'

// The single QuestionPayload constructor - shared by /api/ask (live question event) and
// computeOpenQuestions (questions folded into a Send) so the two payload shapes can't drift.
// lineNumber 0 (whole-file) stamps anchor - the agent reads "file" instead of inferring it.
export function questionPayload(
	state: Pick<ReviewState, 'mode' | 'session'>,
	question: {
		path: string
		lineNumber: number
		side: 'additions' | 'deletions'
		body: string
	},
): QuestionPayload {
	return {
		path: question.path,
		lineNumber: question.lineNumber,
		side: question.side,
		body: question.body,
		anchor: commentAnchor(question.lineNumber),
		mode: state.mode,
		session: state.session,
	}
}

// Questions the reviewer asked but the agent hasn't answered yet. Mirrors the UI's "answered"
// heuristic (src/frontend/widgets/diff-view/annotations.ts): an open question comment is unanswered until a later agent
// reply lands in the same thread (same path/side/line). These ride out on the Send's ReviewResult
// so an agent that never saw the live await still owes each an answer.
export function computeOpenQuestions(state: ReviewState): QuestionPayload[] {
	const isAnswered = (question: ReviewComment): boolean =>
		state.comments.some(
			reply =>
				reply.role === 'agent' &&
				reply.path === question.path &&
				reply.side === question.side &&
				reply.lineNumber === question.lineNumber &&
				+new Date(reply.createdAt) > +new Date(question.createdAt),
		)
	return state.comments
		.filter(
			comment =>
				comment.intent === 'question' &&
				comment.status === 'open' &&
				comment.role !== 'agent' &&
				!isAnswered(comment),
		)
		.map(comment => questionPayload(state, comment))
}

export function buildReviewResult(
	state: ReviewState,
	artifacts: { resultJson: string; sessionDir: string },
	overallNote?: string,
): ReviewResult {
	return {
		session: state.session,
		repoRoot: state.root,
		mode: state.mode,
		target: state.target,
		base: state.base,
		staged: state.staged,
		head: state.head,
		baseDiffHash: state.baseDiffHash,
		accepted: decisionSummaries(state, 'accepted'),
		rejected: decisionSummaries(state, 'rejected'),
		requestedChanges: requestedChanges(state),
		...noteStamp(overallNote?.trim()),
		stagedFiles: state.stagedFiles,
		approvedFiles: computeApprovedFiles(state),
		openQuestions: computeOpenQuestions(state),
		artifacts,
	}
}

// The accepted (or rejected) hunks, in decision order.
function decisionSummaries(
	state: ReviewState,
	status: Decision['status'],
): ReviewResult['accepted'] {
	return effectiveDecisions(state)
		.filter(decision => decision.status === status)
		.map(decision => ({
			path: decision.path,
			lineNumber: decision.lineNumber,
			side: decision.side,
			title: decision.title,
		}))
}

// The change requests going back to the agent: open, reviewer-authored, non-question comments.
// Whole-file requests (the file-header comment) ride out as lineNumber 0 + anchor "file" - no
// line to edit, so the agent applies the remark to the file as a whole; side keeps its additions
// placeholder (uniform array shape, same as the persisted record).
function requestedChanges(
	state: ReviewState,
): ReviewResult['requestedChanges'] {
	return state.comments
		.filter(
			comment =>
				comment.status === 'open' &&
				comment.role !== 'agent' &&
				comment.intent !== 'question',
		)
		.map(comment => ({
			path: comment.path,
			lineNumber: comment.lineNumber,
			side: comment.side,
			body: comment.body,
			anchor: commentAnchor(comment.lineNumber),
		}))
}

// A blank overall note is left off the wire entirely - the agent contract prints `overallNote` only
// when the reviewer wrote one.
function noteStamp(note: string | undefined): { overallNote?: string } {
	if (!note) return {}
	return { overallNote: note }
}
