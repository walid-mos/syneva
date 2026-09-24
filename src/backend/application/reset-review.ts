import type { ResetScope } from '../../contracts/review.js'
import type { ReviewState } from '../domain/review.js'
import type { GitPort } from './ports.js'

// Clear part of the review back to an untouched desk. Returned as a patch rather than
// applied - the desk owns its live state, so the caller that holds it is the one that merges.
//
// - 'review': every decision and sign-off drops, the notes (comments) survive.
// - 'approved': only the signed-off files go back to pending; their decisions, staging and
//   sign-offs drop, everything else - including other files' decisions - stays.
// - 'all': the whole review, notes included.
export function resetReviewPatch(
	state: ReviewState,
	scope: ResetScope,
): Partial<ReviewState> {
	if (scope === 'approved') {
		// reviewedFiles IS the signed-off set, so dropping it drops exactly the approvals.
		const done = new Set(state.reviewedFiles)
		return {
			reviewedFiles: [],
			reviewedFileHashes: {},
			decisionFiles: (state.decisionFiles ?? []).filter(
				p => !done.has(p),
			),
			decisions: (state.decisions ?? []).filter(d => !done.has(d.path)),
			stagedFiles: state.stagedFiles.filter(p => !done.has(p)),
			stagedChangeKeys: (state.stagedChangeKeys ?? []).filter(
				key => !done.has(key.split(':')[0]),
			),
			changes: state.changes.map(change =>
				done.has(change.path)
					? { ...change, status: 'pending', reviewedHash: undefined }
					: change,
			),
		}
	}
	const patch: Partial<ReviewState> = {
		reviewedFiles: [],
		reviewedFileHashes: {},
		stagedFiles: [],
		stagedChangeKeys: [],
		decisionFiles: [],
		decisions: [],
		// 'review' keeps the notes; only 'all' drops the comments.
		comments: scope === 'review' ? state.comments : [],
		changes: state.changes.map(change => ({
			...change,
			status: 'pending',
			reviewedHash: undefined,
		})),
	}
	return patch
}

// Unstage everything the given paths' review touched in one spawn - `git restore --staged`
// takes many pathspecs, so we don't fork per file. PR mode has no working-tree index to
// restore (staging is disabled there), so skip the git work entirely. Fresh checkouts without
// a HEAD commit have no restore target, hence the `git reset` fallback.
export async function unstageReviewedFiles(
	state: ReviewState,
	git: GitPort,
	paths: readonly string[] = state.files.map(file => file.path),
): Promise<void> {
	if (state.mode === 'pr' || !paths.length) return
	await git
		.run(['restore', '--staged', '--', ...paths], state.root)
		.catch(async () =>
			git.run(['reset', 'HEAD', '--', ...paths], state.root),
		)
}
