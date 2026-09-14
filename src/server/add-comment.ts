import crypto from 'node:crypto'

import { anchorTextFor, readFileContents } from '../state/contents.js'
import { nowIso } from '../state/identity.js'

import type { ReviewComment, ReviewState } from '../types.js'

export type CommentRequest = {
	path: string
	side: 'additions' | 'deletions'
	lineNumber: number
	body: string
	role: 'user' | 'agent'
}

// A comment needs a file and a body; everything else has a documented default (additions, line 1,
// an agent-authored reply). Returns null when the request lacks what it cannot default - the route
// answers 422 INVALID_COMMENT.
export function parseCommentRequest(payload: unknown): CommentRequest | null {
	if (typeof payload !== 'object' || payload === null) return null
	const filePath =
		'path' in payload && typeof payload.path === 'string'
			? payload.path
			: ''
	const text =
		'body' in payload && typeof payload.body === 'string'
			? payload.body.trim()
			: ''
	if (!filePath || !text) return null
	const line = 'lineNumber' in payload ? payload.lineNumber : undefined
	return {
		path: filePath,
		lineNumber: Number(line ?? 1),
		side:
			'side' in payload && payload.side === 'deletions'
				? 'deletions'
				: 'additions',
		body: text,
		role: 'role' in payload && payload.role === 'user' ? 'user' : 'agent',
	}
}

// Append a comment to the live review, capturing the anchor text of the line it points at so a
// later reload can re-anchor the thread (see reanchorComments). Fetching just this file's contents
// (the state embeds none) is what makes it work for a file the tab never opened - the resolver reads
// git/the working tree directly. A file whose contents resolve to nothing (deleted, index-only)
// still gets the comment; it simply carries no anchor text.
export async function appendLiveComment(
	state: ReviewState,
	request: CommentRequest,
): Promise<ReviewComment> {
	const now = nowIso()
	const file = state.files.find(candidate => candidate.path === request.path)
	const contents = file
		? await readFileContents(state, file).catch(() => undefined)
		: undefined
	const comment: ReviewComment = {
		id: crypto.randomUUID(),
		path: request.path,
		side: request.side,
		lineNumber: request.lineNumber,
		body: request.body,
		createdAt: now,
		updatedAt: now,
		status: 'open',
		intent: 'note',
		role: request.role,
		anchorText: anchorTextFor(contents, request.side, request.lineNumber),
	}
	state.comments.push(comment)
	return comment
}
