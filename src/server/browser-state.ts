import type {
	BrowserReviewFile,
	BrowserReviewState,
	ReviewFile,
	ReviewState,
} from '../types.js'

function browserFile(file: ReviewFile): BrowserReviewFile {
	return {
		path: file.path,
		oldPath: file.oldPath,
		newPath: file.newPath,
		contentHash: file.contentHash,
		changeKind: file.changeKind,
		// Launch/reload rebuild files with counts before merging any saved reviewer records.
		added: file.added ?? 0,
		removed: file.removed ?? 0,
		hasHunks: file.hunks.length > 0,
		renamePure: file.renamePure,
		oversized: file.oversized,
		size: file.size,
	}
}

// Allowlist both levels: spreading the backend state/files would silently expose future fields.
// Do not mutate or clone diff bodies; staging and reconciliation still own the originals.
export function browserState(state: ReviewState): BrowserReviewState {
	return {
		root: state.root,
		session: state.session,
		mode: state.mode,
		target: state.target,
		staged: state.staged,
		baseDiffHash: state.baseDiffHash,
		files: state.files.map(browserFile),
		changes: state.changes,
		comments: state.comments,
		decisions: state.decisions,
		guide: state.guide,
		reviewedFiles: state.reviewedFiles,
		reviewedFileHashes: state.reviewedFileHashes,
		stagedFiles: state.stagedFiles,
		stagedChangeKeys: state.stagedChangeKeys,
		decisionFiles: state.decisionFiles,
	}
}
