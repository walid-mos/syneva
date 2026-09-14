import { changeKey } from './diff-files.js'

import type { Decision, ReviewState } from '../types.js'

// Decisions[] is the source of truth. For reviews persisted before it existed, derive decisions from
// any decided changes so the handoff/summary stay correct.
export function effectiveDecisions(state: ReviewState): Decision[] {
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
	const decisions = effectiveDecisions(state)
	const isSignedOff = (filePath: string): boolean => {
		const signedHash = signOffHashes[filePath]
		return !!signedHash && signedHash === currentHashes.get(filePath)
	}
	const hasReject = (filePath: string): boolean =>
		decisions.some(
			decision =>
				decision.path === filePath && decision.status === 'rejected',
		)
	const hasOpenChange = (filePath: string): boolean =>
		state.comments.some(
			comment =>
				comment.path === filePath &&
				comment.status === 'open' &&
				comment.role !== 'agent' &&
				comment.intent !== 'question',
		)
	return state.reviewedFiles.filter(
		filePath =>
			isSignedOff(filePath) &&
			!hasReject(filePath) &&
			!hasOpenChange(filePath),
	)
}
