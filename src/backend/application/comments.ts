import crypto from 'node:crypto'

import { isFileLevelLine, newComment } from '../domain/comments.js'

import { readFileContents } from './contents.js'
import { nowIso } from './time.js'

import type { CommentInput } from '../domain/comments.js'
import type { FileContents } from '../domain/contents.js'
import type { ReviewComment, ReviewState } from '../domain/review.js'
import type { GitPort, ReviewStorePort } from './ports.js'

// Append a comment to the persisted review, capturing the anchor text of the line it points at so a
// later reload can re-anchor the thread (see reanchorComments in backend/domain/comments.ts).
// Whole-file comments skip the content read entirely - they have no line to anchor.
// The comment's collaborator ports: the review store (load + persist) and git (the anchor
// file's on-demand contents).
export type CommentIo = { store: ReviewStorePort; git: GitPort }

// The one conditional contents read a new comment needs: line comments read their file's
// contents to capture the anchor line (the state embeds none); whole-file comments read nothing.
// Shared by the offline path (appendComment) and the live path (appendLiveComment).
export async function commentContents(
	state: ReviewState,
	input: CommentInput,
	git: GitPort,
): Promise<FileContents | undefined> {
	const file = state.files.find(candidate => candidate.path === input.path)
	if (!file || isFileLevelLine(input.lineNumber)) return undefined
	return await readFileContents(state, file, git)
}

export async function appendComment(
	root: string,
	session: string,
	input: CommentInput,
	io: CommentIo,
): Promise<ReviewComment> {
	const saved = await io.store.loadLatestReview(root, session)
	if (!saved)
		throw new Error(
			`No saved review for session "${session}" in ${root}. Open the desk first.`,
		)
	// Line comments need the file's contents to capture the anchor line (the state embeds none);
	// a whole-file comment needs nothing read.
	const comment = newComment(
		input,
		await commentContents(saved, input, io.git),
		crypto.randomUUID(),
		nowIso(),
	)
	// Copy-on-write: a new root with only the comments branch replaced, persisted wholesale.
	await io.store.persistReview({
		...saved,
		comments: [...saved.comments, comment],
	})
	return comment
}
