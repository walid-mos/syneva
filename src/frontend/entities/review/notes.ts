import { isFileComment } from './changes'

import type { Side } from '@shared/diff-renderer/types'
import type { ReviewComment, ReviewState } from './model'

// ── Review notes: every comment/question thread as one navigable entry ──────
// The notes panel needs the whole review's threads (not just the current file's),
// grouped the way the diff groups them (same path + side:line, file comments apart)
// so a click can land exactly where the thread renders. Pure derivation off the live
// state - no IO, no DOM - so the panel and any future consumer share one shape.

export type ReviewNote = {
	// "question" when any member carries the question intent (the Ask composer stamps
	// it; agent replies ride the same thread group), "comment" otherwise.
	kind: 'question' | 'comment'
	path: string
	side: Side
	lineNumber: number
	endLine?: number
	// The thread anchors to the file header (whole-file comment), not a diff row.
	fileLevel: boolean
	// The thread's anchor moved out of the diff (server re-anchoring stamped it); it
	// renders in the strip above the diff instead of on a row.
	unanchored: boolean
	// open: some member still open (unanswered for a question); answered: open
	// question with an agent reply in the thread; resolved: every member resolved.
	status: 'open' | 'answered' | 'resolved'
	// First message, single-lined and capped - the row's body.
	preview: string
	// Newest message (the agent's answer, on an answered question thread).
	latest: string
	// Messages in the thread.
	count: number
	updatedAt: string
	comments: ReviewComment[]
}

const PREVIEW_MAX = 120
const PREVIEW_HEAD = 117

function oneline(body: string): string {
	const text = body.replace(/\s+/g, ' ').trim()
	return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_HEAD)}…` : text
}

// An open question is answered once an agent reply lands in its thread after the
// question - the same heuristic the diff's thread UI and the Send handoff
// (computeOpenQuestions) use, kept in one place here for the panel.
function isAnswered(group: ReviewComment[]): boolean {
	const question = group.find(c => c.intent === 'question')
	if (!question) return false
	return group.some(
		reply =>
			reply.role === 'agent' &&
			+new Date(reply.createdAt) > +new Date(question.createdAt),
	)
}

// Thread status: open wins over its answered refinement; no open member means resolved.
function threadStatus(
	group: ReviewComment[],
	kind: ReviewNote['kind'],
): ReviewNote['status'] {
	if (!group.some(c => c.status === 'open')) return 'resolved'
	if (kind === 'question' && isAnswered(group)) return 'answered'
	return 'open'
}

function toNote(group: ReviewComment[]): ReviewNote {
	// Group members arrive oldest-first (see reviewNotes), so first is the anchor
	// message and last is the newest word in the conversation.
	const [first] = group
	const last = group[group.length - 1]
	const kind = group.some(c => c.intent === 'question')
		? 'question'
		: 'comment'
	const note: ReviewNote = {
		kind,
		path: first.path,
		side: first.side,
		lineNumber: first.lineNumber,
		fileLevel: isFileComment(first),
		unanchored: group.some(c => c.unanchored === true),
		status: threadStatus(group, kind),
		preview: oneline(first.body),
		latest: oneline(last.body),
		count: group.length,
		updatedAt: last.updatedAt,
		comments: group,
	}
	if (typeof first.endLine === 'number') note.endLine = first.endLine
	return note
}

// Every thread in the review as navigable notes, ordered for a top-to-bottom read:
// by file (review order), then line, then the thread's own chronology. Resolved
// threads stay in the list (a click still scrolls to their collapsed summary).
export function reviewNotes(state: ReviewState | null): ReviewNote[] {
	if (!state) return []
	const groups = new Map<string, ReviewComment[]>()
	for (const c of state.comments) {
		const key = isFileComment(c)
			? `${c.path}\u0000file`
			: `${c.path}\u0000${c.side}:${c.lineNumber}`
		const group = groups.get(key)
		if (group) group.push(c)
		else groups.set(key, [c])
	}
	const fileOrder = new Map<string, number>(
		state.files.map((f, i) => [f.path, i] as const),
	)
	return [...groups.values()]
		.map(group =>
			group.toSorted(
				(a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
			),
		)
		.map(toNote)
		.toSorted((a, b) => {
			const fa = fileOrder.get(a.path) ?? state.files.length
			const fb = fileOrder.get(b.path) ?? state.files.length
			if (fa !== fb) return fa - fb
			if (a.lineNumber !== b.lineNumber)
				return a.lineNumber - b.lineNumber
			return +new Date(a.updatedAt) - +new Date(b.updatedAt)
		})
}
