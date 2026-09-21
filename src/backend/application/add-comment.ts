import crypto from 'node:crypto'

import {
	commentAnchor,
	commentSide,
	isFileLevelLine,
} from '../domain/comments.js'
import { anchorTextFor } from '../domain/contents.js'

import { readFileContents } from './contents.js'
import { nowIso } from './time.js'

import type { ReviewComment, ReviewState } from '../domain/review.js'
import type { GitPort } from './ports.js'

export type CommentRequest = {
	path: string
	side: 'additions' | 'deletions'
	lineNumber: number
	body: string
	role: 'user' | 'agent'
}

export type AppendedComment = {
	// The next state root with the comment appended (copy-on-write: a new comments array,
	// every other branch shared) - the caller persists and commits it; the live state object
	// is never edited in place.
	state: ReviewState
	comment: ReviewComment
}

// Append a comment to the review, capturing the anchor text of the line it points at so a
// later reload can re-anchor the thread (see reanchorComments). Fetching just this file's contents
// (the state embeds none) is what makes it work for a file the tab never opened - the resolver reads
// git/the working tree directly. A file whose contents resolve to nothing (deleted, index-only)
// still gets the comment; it simply carries no anchor text. Whole-file comments skip the content
// read - they have no line to anchor. The constructed record is immutable domain data (readonly
// fields), built fresh for the domain collection - never a shared protocol object.
export async function appendLiveComment(
	state: ReviewState,
	request: CommentRequest,
	git: GitPort,
): Promise<AppendedComment> {
	const now = nowIso()
	const file = state.files.find(candidate => candidate.path === request.path)
	const contents =
		file && !isFileLevelLine(request.lineNumber)
			? await readFileContents(state, file, git).catch(() => undefined)
			: undefined
	const comment: ReviewComment = {
		id: crypto.randomUUID(),
		path: request.path,
		side: commentSide(request.side, request.lineNumber),
		lineNumber: request.lineNumber,
		body: request.body,
		createdAt: now,
		updatedAt: now,
		status: 'open',
		intent: 'note',
		role: request.role,
		anchor: commentAnchor(request.lineNumber),
		anchorText: anchorTextFor(contents, request.side, request.lineNumber),
	}
	return {
		state: { ...state, comments: [...state.comments, comment] },
		comment,
	}
}
