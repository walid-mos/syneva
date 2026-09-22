import { asBoolean, asNumber, asOneOf, asString, isObject } from './dto.js'

import type {
	ChangeState,
	Decision,
	Guide,
	ReviewComment,
} from '../../../domain/review.js'
import type { Raw } from './dto.js'

// The persisted review file's storage DTO for the review-level records (the identity
// header, comments, decisions, changes, and the guide). The on-disk JSON is decoded into
// domain records field by field - never cast - and encoded back through the same
// allowlist, so a field only reaches disk when it is listed here and unknown or
// malformed data can never enter the live review state. The format is frozen: newer
// desk runs read older files (missing optionals decode to their defaults) and older
// runs keep reading newer records (unknown fields are dropped, not rejected). Malformed
// nested records are dropped rather than fatal - a persisted file always loads whatever
// is intact - while a file lacking its identity fields is not a review record at all
// (decodeReviewStateFile reports that so the caller can skip the candidate). The diff
// envelope (ReviewFile/hunks/lines) lives in diff-envelope-dto.ts.

// Decode a whole persisted review body, or null when it is not a review record:
// without the identity triple the file cannot be attributed to any review (a foreign
// or truncated file) and the caller skips it.
export function decodeReviewStateFile(
	parsed: unknown,
): { id: string; session: string; root: string; body: Raw } | null {
	if (!isObject(parsed)) return null
	// The identity triple is what a loader keys on (session dir + repo root).
	const id = asString(parsed.id)
	const session = asString(parsed.session)
	const root = asString(parsed.root)
	if (id === null || session === null || root === null) return null
	return { id, session, root, body: parsed }
}

export function decodeComment(raw: unknown): ReviewComment | null {
	if (!isObject(raw)) return null
	const core = decodeCommentCore(raw)
	if (core === null) return null
	return { ...core, ...decodeCommentMeta(raw) }
}

// The required comment fields: all-or-nothing, so a record missing any one of them is dropped.
function decodeCommentCore(raw: Raw): {
	id: string
	path: string
	body: string
	createdAt: string
	updatedAt: string
	lineNumber: number
	status: ReviewComment['status']
	side: ReviewComment['side']
} | null {
	const id = asString(raw.id)
	const path = asString(raw.path)
	const body = asString(raw.body)
	const createdAt = asString(raw.createdAt)
	const updatedAt = asString(raw.updatedAt)
	const lineNumber = asNumber(raw.lineNumber)
	const status = asOneOf(raw.status, ['open', 'resolved', 'stale'] as const)
	const side = asOneOf(raw.side, ['additions', 'deletions'] as const)
	if (
		id === null ||
		path === null ||
		body === null ||
		createdAt === null ||
		updatedAt === null ||
		lineNumber === null ||
		status === null ||
		side === null
	)
		return null
	return { id, path, body, createdAt, updatedAt, lineNumber, status, side }
}

// The optional comment fields.
function decodeCommentMeta(raw: Raw): Partial<ReviewComment> {
	return {
		endLine: asNumber(raw.endLine) ?? undefined,
		intent:
			asOneOf(raw.intent, ['note', 'action', 'question'] as const) ??
			undefined,
		role: asOneOf(raw.role, ['user', 'agent'] as const) ?? undefined,
		anchorText: asString(raw.anchorText) ?? undefined,
		unanchored: asBoolean(raw.unanchored) ?? undefined,
		anchor: asOneOf(raw.anchor, ['file'] as const) ?? undefined,
	}
}

export function decodeChange(raw: unknown): ChangeState | null {
	if (!isObject(raw)) return null
	const id = asString(raw.id)
	const path = asString(raw.path)
	const hunkIndex = asNumber(raw.hunkIndex)
	const title = asString(raw.title)
	const lineNumber = asNumber(raw.lineNumber)
	const side = asOneOf(raw.side, ['additions', 'deletions'] as const)
	const status = asOneOf(raw.status, [
		'pending',
		'accepted',
		'rejected',
	] as const)
	if (
		id === null ||
		path === null ||
		hunkIndex === null ||
		title === null ||
		lineNumber === null ||
		side === null ||
		status === null
	)
		return null
	// Display anchors are derived per render and never trusted from disk - the fields
	// are deliberately absent from this decode.
	return {
		id,
		path,
		hunkIndex,
		changeIndex: asNumber(raw.changeIndex) ?? undefined,
		side,
		lineNumber,
		endLine: asNumber(raw.endLine) ?? undefined,
		title,
		stableKey: asString(raw.stableKey) ?? undefined,
		status,
		stageable: asBoolean(raw.stageable) ?? undefined,
		contentHash: asString(raw.contentHash) ?? undefined,
		reviewedHash: asString(raw.reviewedHash) ?? undefined,
	}
}

export function decodeDecision(raw: unknown): Decision | null {
	if (!isObject(raw)) return null
	const key = asString(raw.key)
	const path = asString(raw.path)
	const title = asString(raw.title)
	const lineNumber = asNumber(raw.lineNumber)
	const side = asOneOf(raw.side, ['additions', 'deletions'] as const)
	const status = asOneOf(raw.status, ['accepted', 'rejected'] as const)
	if (
		key === null ||
		path === null ||
		title === null ||
		lineNumber === null ||
		side === null ||
		status === null
	)
		return null
	return {
		key,
		status,
		reviewedHash: asString(raw.reviewedHash) ?? undefined,
		path,
		lineNumber,
		side,
		title,
	}
}

export function decodeGuide(raw: unknown): Guide | null {
	if (!isObject(raw)) return null
	if (!Array.isArray(raw.files)) return null
	const files: Guide['files'] = []
	for (const entry of raw.files) {
		if (!isObject(entry)) return null
		const path = asString(entry.path)
		const order = asNumber(entry.order)
		const category = asString(entry.category)
		if (path === null || order === null || category === null) return null
		files.push({ path, order, category })
	}
	return { files, baseDiffHash: asString(raw.baseDiffHash) ?? undefined }
}

// ── encode: domain records → persisted JSON ─────────────────────────────────────
// Field-wise allowlists, so a future domain field stays private to the process until
// it is added to the storage contract here. The persisted JSON shape is exactly what
// these builders list - JSON.stringify omits undefined-valued keys, so the file bytes
// are identical to an explicit conditional-omit mapping.

export function encodeComment(comment: ReviewComment): Raw {
	return {
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
	}
}

export function encodeChange(change: ChangeState): Raw {
	// Display anchors, if a stale in-memory record somehow carries them, are not
	// storage data - they are re-derived per render.
	return {
		id: change.id,
		path: change.path,
		hunkIndex: change.hunkIndex,
		side: change.side,
		lineNumber: change.lineNumber,
		title: change.title,
		status: change.status,
		changeIndex: change.changeIndex,
		endLine: change.endLine,
		stableKey: change.stableKey,
		stageable: change.stageable,
		contentHash: change.contentHash,
		reviewedHash: change.reviewedHash,
	}
}

export function encodeDecision(decision: Decision): Raw {
	return {
		key: decision.key,
		status: decision.status,
		path: decision.path,
		lineNumber: decision.lineNumber,
		side: decision.side,
		title: decision.title,
		reviewedHash: decision.reviewedHash,
	}
}

export function encodeGuide(guide: Guide): Raw {
	return {
		files: guide.files.map(file => ({
			path: file.path,
			order: file.order,
			category: file.category,
		})),
		baseDiffHash: guide.baseDiffHash,
	}
}
