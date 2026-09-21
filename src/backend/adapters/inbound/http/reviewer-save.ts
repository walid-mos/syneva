import { reviewerSavePatch } from '../../../application/send-review.js'
import { commentSide } from '../../../domain/comments.js'

import { HTTP_UNPROCESSABLE } from './http.js'

import type { ReviewerSavePatch } from '../../../application/send-review.js'
import type { Decision, ReviewComment } from '../../../domain/review.js'
import type { ApiFailure } from './failure.js'

// Transport DTO decode for the reviewer-owned slice carried by /api/save and /api/send
// bodies. The raw JSON is shaped into domain records field by field - never cast - so a
// malformed patch is rejected here (422) instead of reaching the review state, where it
// would fail later during result building, polling, or reconciliation. A key that is
// absent from the body is left untouched (snapshot semantics, latest wins: a stale open
// tab may still POST the whole old ReviewState - everything not allowlisted is ignored).
// Domain business rules (hash freshness, comment anchoring) stay in the application/domain.
//
// Required-field decoders return null (not undefined) on absence/wrong kind - see the
// rationale on dto.ts in the filesystem adapter: a null comparison keeps legitimate
// falsy values (empty string, 0) distinguishable from a missing field.

export const INVALID_SAVE: ApiFailure = {
	status: HTTP_UNPROCESSABLE,
	code: 'INVALID_SAVE',
	error: 'The save body carries a malformed reviewer field.',
	fix: 'POST the reviewer slice { decisions, comments, reviewedFiles, reviewedFileHashes, decisionFiles }; each record must match its documented shape.',
}

// A generic runtime guard is a deliberate low-level exception here: this is the save
// body's DTO decode primitive, and the field decoders below do the schema validation.
// oxlint-disable-next-line nextnode/no-generic-runtime-guard
function isRecord(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === 'object' && raw !== null
}

export function parseReviewerSave(body: unknown): ReviewerSavePatch | null {
	// The reviewer-owned KEY policy is application-owned (reviewerSavePatch): one list decides
	// which keys a save may carry. This decode adds what the transport owes on top - the
	// record-level DTO validation that turns a syntactically valid body with a malformed
	// record into a 422 instead of a corrupt patch reaching the review state.
	const slice = reviewerSavePatch(body)
	const patch: ReviewerSavePatch = {}
	if ('decisions' in slice) {
		const decisions = parseDecisions(slice.decisions)
		if (decisions === null) return null
		patch.decisions = decisions
	}
	if ('comments' in slice) {
		const comments = parseComments(slice.comments)
		if (comments === null) return null
		patch.comments = comments
	}
	if ('reviewedFiles' in slice) {
		const files = parseStringArray(slice.reviewedFiles)
		if (files === null) return null
		patch.reviewedFiles = files
	}
	if ('reviewedFileHashes' in slice) {
		const hashes = parseStringRecord(slice.reviewedFileHashes)
		if (hashes === null) return null
		patch.reviewedFileHashes = hashes
	}
	if ('decisionFiles' in slice) {
		const files = parseStringArray(slice.decisionFiles)
		if (files === null) return null
		patch.decisionFiles = files
	}
	return patch
}

// ── per-field decoders ──────────────────────────────────────────────────────────

function parseDecisions(raw: unknown): Decision[] | null {
	if (!Array.isArray(raw)) return null
	const decisions: Decision[] = []
	for (const entry of raw) {
		if (!isRecord(entry)) return null
		const key = asNonEmptyString(entry.key)
		const path = asNonEmptyString(entry.path)
		const title = asString(entry.title)
		const lineNumber = asFiniteNumber(entry.lineNumber)
		const side = asSide(entry.side)
		const status = asDecisionStatus(entry.status)
		if (
			key === null ||
			path === null ||
			title === null ||
			lineNumber === null ||
			side === null ||
			status === null
		)
			return null
		const reviewedHash = asOptionalString(entry.reviewedHash)
		decisions.push({
			key,
			status,
			reviewedHash,
			path,
			lineNumber,
			side,
			title,
		})
	}
	return decisions
}

function parseComments(raw: unknown): ReviewComment[] | null {
	if (!Array.isArray(raw)) return null
	const comments: ReviewComment[] = []
	for (const entry of raw) {
		const comment = parseComment(entry)
		if (comment === null) return null
		comments.push(comment)
	}
	return comments
}

function parseComment(raw: unknown): ReviewComment | null {
	if (!isRecord(raw)) return null
	const core = parseCommentCore(raw)
	if (core === null) return null
	// A comment's side normalizes through the domain rule (a whole-file comment carries
	// the additions placeholder whatever arrived - see commentSide).
	const side = commentSide(asSide(raw.side) ?? 'additions', core.lineNumber)
	// A present endLine must be a finite number - anything else is a 422.
	const endLine = raw.endLine ? asFiniteNumber(raw.endLine) : undefined
	if (endLine === null) return null
	return { ...core, ...parseCommentMeta(raw), side, endLine }
}

// The required comment fields: all-or-nothing, so a body missing any one of them is a 422.
function parseCommentCore(raw: Record<string, unknown>): {
	id: string
	path: string
	body: string
	createdAt: string
	updatedAt: string
	lineNumber: number
	status: ReviewComment['status']
} | null {
	const id = asNonEmptyString(raw.id)
	const path = asString(raw.path)
	const body = asString(raw.body)
	const createdAt = asString(raw.createdAt)
	const updatedAt = asString(raw.updatedAt)
	const lineNumber = asFiniteNumber(raw.lineNumber)
	const status = asCommentStatus(raw.status)
	if (
		id === null ||
		path === null ||
		body === null ||
		createdAt === null ||
		updatedAt === null ||
		lineNumber === null ||
		status === null
	)
		return null
	return { id, path, body, createdAt, updatedAt, lineNumber, status }
}

// The optional comment fields.
function parseCommentMeta(
	raw: Record<string, unknown>,
): Partial<ReviewComment> {
	const intent =
		raw.intent === 'note' ||
		raw.intent === 'action' ||
		raw.intent === 'question'
			? raw.intent
			: undefined
	const role =
		raw.role === 'user' || raw.role === 'agent' ? raw.role : undefined
	return {
		intent,
		role,
		anchorText: asOptionalString(raw.anchorText),
		unanchored: raw.unanchored === true ? true : undefined,
		anchor: raw.anchor === 'file' ? 'file' : undefined,
	}
}

function asCommentStatus(raw: unknown): ReviewComment['status'] | null {
	if (raw === 'open' || raw === 'resolved' || raw === 'stale') return raw
	return null
}

function asDecisionStatus(raw: unknown): 'accepted' | 'rejected' | null {
	if (raw === 'accepted' || raw === 'rejected') return raw
	return null
}

function parseStringArray(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null
	const values: string[] = []
	for (const entry of raw) {
		const text = asString(entry)
		if (text === null) return null
		values.push(text)
	}
	return values
}

function parseStringRecord(raw: unknown): Record<string, string> | null {
	if (!isRecord(raw)) return null
	const record: Record<string, string> = {}
	for (const [key, entry] of Object.entries(raw)) {
		const text = asString(entry)
		if (text === null) return null
		record[key] = text
	}
	return record
}

function asString(raw: unknown): string | null {
	if (typeof raw === 'string') return raw
	return null
}

function asNonEmptyString(raw: unknown): string | null {
	if (typeof raw === 'string' && raw.trim()) return raw
	return null
}

function asOptionalString(raw: unknown): string | undefined {
	if (typeof raw === 'string' && raw) return raw
	return undefined
}

function asFiniteNumber(raw: unknown): number | null {
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw
	return null
}

function asSide(raw: unknown): 'additions' | 'deletions' | null {
	if (raw === 'additions' || raw === 'deletions') return raw
	return null
}
