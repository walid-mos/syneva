import crypto from 'node:crypto'

import { newComment } from '../domain/comments.js'

import { commentContents } from './comments.js'
import { nowIso } from './time.js'

import type { CommentInput } from '../domain/comments.js'
import type { ReviewComment, ReviewState } from '../domain/review.js'
import type { GitPort } from './ports.js'

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
// fields), built fresh for the domain collection - never a shared protocol object. The live path's
// one IO difference from the offline path: a failed contents read degrades to "no anchor text"
// instead of failing the desk round-trip.
export async function appendLiveComment(
	state: ReviewState,
	request: CommentInput,
	git: GitPort,
): Promise<AppendedComment> {
	const comment = newComment(
		request,
		await commentContents(state, request, git).catch(() => undefined),
		crypto.randomUUID(),
		nowIso(),
	)
	return {
		state: { ...state, comments: [...state.comments, comment] },
		comment,
	}
}
