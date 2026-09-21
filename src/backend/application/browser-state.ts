import type {
	BrowserReviewFile,
	BrowserReviewState,
} from '../../contracts/browser.js'
import type {
	ChangeState,
	Decision,
	Guide,
	ReviewComment,
} from '../../contracts/review.js'
import type {
	ChangeState as DomainChange,
	Decision as DomainDecision,
	Guide as DomainGuide,
	ReviewComment as DomainComment,
	ReviewFile,
	ReviewState,
} from '../domain/review.js'

// The browser projection: the one place the domain review is translated onto the wire
// DTOs. Every level is mapped field by field - files, and the nested change/comment/
// decision/guide records - so a future backend-only field stays private until it is
// allowlisted here, and no domain record object is ever shared with the wire (the
// serializer and the browser each own their copies).

// Optional DTO fields that are absent on the source record stay absent on the wire object:
// a key explicitly set to undefined is noise in equality checks and diagnostics. A JSON
// round-trip strips exactly those keys (JSON.stringify omits undefined-valued properties,
// and nothing else - every wire DTO field is JSON-safe) and keeps legitimate falsy values
// (false, 0, ''). structuredClone would NOT strip them (an undefined-valued key survives
// the clone), so the round-trip is the correct primitive here.
// oxlint-disable-next-line unicorn/prefer-structured-clone
function withoutUndefined<Dto extends object>(dto: Dto): Dto {
	// structuredClone keeps undefined-valued keys (they survive the clone) - only the
	// JSON round-trip strips them.
	// oxlint-disable-next-line unicorn/prefer-structured-clone
	return JSON.parse(JSON.stringify(dto))
}

function browserFile(file: ReviewFile): BrowserReviewFile {
	return withoutUndefined({
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
	})
}

function browserComment(comment: DomainComment): ReviewComment {
	return withoutUndefined({
		id: comment.id,
		path: comment.path,
		side: comment.side,
		lineNumber: comment.lineNumber,
		endLine: comment.endLine,
		body: comment.body,
		createdAt: comment.createdAt,
		updatedAt: comment.updatedAt,
		status: comment.status,
		intent: comment.intent,
		role: comment.role,
		anchorText: comment.anchorText,
		unanchored: comment.unanchored,
		anchor: comment.anchor,
	})
}

function browserChange(change: DomainChange): ChangeState {
	return withoutUndefined({
		id: change.id,
		path: change.path,
		hunkIndex: change.hunkIndex,
		changeIndex: change.changeIndex,
		side: change.side,
		lineNumber: change.lineNumber,
		endLine: change.endLine,
		title: change.title,
		stableKey: change.stableKey,
		status: change.status,
		stageable: change.stageable,
		contentHash: change.contentHash,
		reviewedHash: change.reviewedHash,
		// Display anchors are the browser's own derived projection (syncDisplayAnchors) -
		// never carried from the domain record.
	})
}

function browserDecision(decision: DomainDecision): Decision {
	return withoutUndefined({
		key: decision.key,
		status: decision.status,
		reviewedHash: decision.reviewedHash,
		path: decision.path,
		lineNumber: decision.lineNumber,
		side: decision.side,
		title: decision.title,
	})
}

function browserGuide(guide: DomainGuide): Guide {
	return withoutUndefined({
		files: guide.files.map(file => ({
			path: file.path,
			order: file.order,
			category: file.category,
		})),
		baseDiffHash: guide.baseDiffHash,
	})
}

// Allowlist every level: spreading the backend state/files would silently expose future fields.
// Do not mutate or clone diff bodies; staging and reconciliation still own the originals.
export function browserState(state: ReviewState): BrowserReviewState {
	return withoutUndefined({
		root: state.root,
		session: state.session,
		mode: state.mode,
		target: state.target,
		staged: state.staged,
		baseDiffHash: state.baseDiffHash,
		files: state.files.map(browserFile),
		changes: state.changes.map(browserChange),
		comments: state.comments.map(browserComment),
		decisions: state.decisions?.map(browserDecision),
		guide: state.guide ? browserGuide(state.guide) : undefined,
		reviewedFiles: state.reviewedFiles,
		reviewedFileHashes: state.reviewedFileHashes,
		stagedFiles: state.stagedFiles,
		stagedChangeKeys: state.stagedChangeKeys,
		decisionFiles: state.decisionFiles,
	})
}
