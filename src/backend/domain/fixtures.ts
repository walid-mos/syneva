import type {
	ChangeState,
	Decision,
	ReviewComment,
	ReviewFile,
	ReviewState,
} from './review.js'

// Shared builders for the state-domain tests: one per record the modules under test reconcile,
// persist or post, holding only the fields those modules read and overridable per case.
export function file(filePath: string, contentHash = 'FH'): ReviewFile {
	return {
		path: filePath,
		hunks: [],
		contentHash,
		changeKind: 'modified',
	}
}

export function change(
	over: Partial<ChangeState> & { id: string; path: string },
): ChangeState {
	return {
		hunkIndex: 0,
		side: 'additions',
		lineNumber: 1,
		title: '',
		status: 'pending',
		...over,
	}
}

export function comment(
	over: Partial<ReviewComment> & { id: string; path: string },
): ReviewComment {
	return {
		side: 'additions',
		lineNumber: 1,
		body: '',
		createdAt: 't',
		updatedAt: 't',
		status: 'open',
		...over,
	}
}

export function decision(
	over: Partial<Decision> & { key: string; path: string },
): Decision {
	return {
		status: 'accepted',
		lineNumber: 1,
		side: 'additions',
		title: '',
		...over,
	}
}

export function state(over: Partial<ReviewState>): ReviewState {
	return {
		id: 'id',
		session: 's',
		root: '/r',
		repoHash: 'h',
		mode: 'repo',
		staged: false,
		head: null,
		baseDiffHash: 'base',
		createdAt: 't',
		rawDiff: '',
		files: [],
		comments: [],
		changes: [],
		reviewedFiles: [],
		stagedFiles: [],
		...over,
	}
}
