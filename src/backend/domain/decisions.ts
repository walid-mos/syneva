import { changeKey } from './change-blocks.js'

import type { Decision, ReviewState } from './review.js'

// Decisions[] is the source of truth. For reviews persisted before it existed, derive decisions from
// any decided changes so the handoff/summary stay correct.
export function effectiveDecisions(state: ReviewState): readonly Decision[] {
	if (state.decisions) return state.decisions
	const derived: Decision[] = []
	for (const change of state.changes) {
		if (change.status === 'pending') continue
		derived.push({
			key: changeKey(change),
			status: change.status,
			reviewedHash: change.reviewedHash,
			path: change.path,
			lineNumber: change.lineNumber,
			side: change.side,
			title: change.title,
		})
	}
	return derived
}

// Files the reviewer signed off as-is: finished (in reviewedFiles, content hash still current)
// AND with no objections - no rejected hunk and no open requested-change comment (questions and
// agent replies don't count). Guarantees approvedFiles is disjoint from rejected/requestedChanges.
export function computeApprovedFiles(state: ReviewState): string[] {
	const signOffHashes = state.reviewedFileHashes ?? {}
	const currentHashes = new Map(
		state.files.map(file => [file.path, file.contentHash]),
	)
	// One pass per collection builds the objection sets, so the per-file check below is O(1)
	// instead of re-scanning all decisions/comments per reviewed file on every Send.
	const rejected = new Set<string>()
	for (const decision of effectiveDecisions(state))
		if (decision.status === 'rejected') rejected.add(decision.path)
	const openChanges = new Set<string>()
	for (const comment of state.comments)
		if (
			comment.status === 'open' &&
			comment.role !== 'agent' &&
			comment.intent !== 'question'
		)
			openChanges.add(comment.path)
	const isSignedOff = (filePath: string): boolean => {
		const signedHash = signOffHashes[filePath]
		return !!signedHash && signedHash === currentHashes.get(filePath)
	}
	return state.reviewedFiles.filter(
		filePath =>
			isSignedOff(filePath) &&
			!rejected.has(filePath) &&
			!openChanges.has(filePath),
	)
}
