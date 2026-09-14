import { git } from '../git/exec.js'

import type { ReviewState } from '../types.js'

// Clear the review back to an untouched desk: drop the reviewer's records and return every change to
// pending. Returned as a patch rather than applied - the desk owns its live state, so the caller that
// holds it is the one that merges.
export function resetReviewPatch(state: ReviewState): Partial<ReviewState> {
	return {
		comments: [],
		reviewedFiles: [],
		reviewedFileHashes: {},
		stagedFiles: [],
		stagedChangeKeys: [],
		decisionFiles: [],
		decisions: [],
		changes: state.changes.map(change => ({
			...change,
			status: 'pending',
			reviewedHash: undefined,
		})),
	}
}

// Unstage everything the review touched in one spawn - `git restore --staged` takes many pathspecs,
// so we don't fork per file. PR mode has no working-tree index to restore (staging is disabled there),
// so skip the git work entirely. Fresh checkouts without a HEAD commit have no restore target, hence
// the `git reset` fallback.
export async function unstageReviewedFiles(state: ReviewState): Promise<void> {
	if (state.mode === 'pr' || !state.files.length) return
	const paths = state.files.map(file => file.path)
	await git(['restore', '--staged', '--', ...paths], state.root).catch(
		async () => git(['reset', 'HEAD', '--', ...paths], state.root),
	)
}
