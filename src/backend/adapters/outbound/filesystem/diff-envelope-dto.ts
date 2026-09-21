import { asBoolean, asNumber, asOneOf, asString, isObject } from './dto.js'

import type {
	DiffFile,
	DiffHunk,
	DiffLine,
	ReviewFile,
} from '../../../domain/review.js'
import type { Raw } from './dto.js'

// The persisted diff envelope: one ReviewFile per diff entry - the parsed hunks/lines
// plus the builder's lean stamps - decoded field by field (no JSON.parse output is ever
// trusted as a domain record without it) and encoded back through the same allowlist.
// Review-level records (comments/decisions/changes/guide) live in review-file-dto.ts.

export function decodeReviewFile(raw: unknown): ReviewFile | null {
	if (!isObject(raw)) return null
	const path = asString(raw.path)
	const contentHash = asString(raw.contentHash)
	if (path === null || contentHash === null) return null
	if (!Array.isArray(raw.hunks)) return null
	const hunks: DiffHunk[] = []
	for (const entry of raw.hunks) {
		const hunk = decodeHunk(entry)
		if (hunk === null) return null
		hunks.push(hunk)
	}
	const file: DiffFile = {
		oldPath: asString(raw.oldPath) ?? undefined,
		newPath: asString(raw.newPath) ?? undefined,
		hunks,
	}
	return {
		...file,
		path,
		contentHash,
		changeKind:
			asOneOf(raw.changeKind, [
				'added',
				'modified',
				'deleted',
				'renamed',
			] as const) ?? undefined,
		added: asNumber(raw.added) ?? undefined,
		removed: asNumber(raw.removed) ?? undefined,
		renamePure: asBoolean(raw.renamePure) ?? undefined,
		size: asNumber(raw.size) ?? undefined,
		oversized: asBoolean(raw.oversized) ?? undefined,
	}
}

function decodeHunk(raw: unknown): DiffHunk | null {
	if (!isObject(raw)) return null
	const header = asString(raw.header)
	const oldStart = asNumber(raw.oldStart)
	const oldCount = asNumber(raw.oldCount)
	const newStart = asNumber(raw.newStart)
	const newCount = asNumber(raw.newCount)
	if (
		header === null ||
		oldStart === null ||
		oldCount === null ||
		newStart === null ||
		newCount === null ||
		!Array.isArray(raw.lines)
	)
		return null
	const lines: DiffLine[] = []
	for (const entry of raw.lines) {
		const line = decodeLine(entry)
		if (line === null) return null
		lines.push(line)
	}
	return { header, oldStart, oldCount, newStart, newCount, lines }
}

function decodeLine(raw: unknown): DiffLine | null {
	if (!isObject(raw)) return null
	const kind = asOneOf(raw.kind, ['context', 'add', 'delete'] as const)
	const text = asString(raw.text)
	const diffPosition = asNumber(raw.diffPosition)
	const hunkHeader = asString(raw.hunkHeader)
	if (
		kind === null ||
		text === null ||
		diffPosition === null ||
		hunkHeader === null
	)
		return null
	return {
		kind,
		text,
		oldLine: asNumber(raw.oldLine) ?? undefined,
		newLine: asNumber(raw.newLine) ?? undefined,
		diffPosition,
		hunkHeader,
	}
}

export function encodeReviewFile(file: ReviewFile): Raw {
	return {
		path: file.path,
		contentHash: file.contentHash,
		hunks: file.hunks.map(encodeHunk),
		oldPath: file.oldPath,
		newPath: file.newPath,
		changeKind: file.changeKind,
		added: file.added,
		removed: file.removed,
		renamePure: file.renamePure,
		size: file.size,
		oversized: file.oversized,
	}
}

function encodeHunk(hunk: DiffHunk): Raw {
	return {
		header: hunk.header,
		oldStart: hunk.oldStart,
		oldCount: hunk.oldCount,
		newStart: hunk.newStart,
		newCount: hunk.newCount,
		lines: hunk.lines.map(line => ({
			kind: line.kind,
			text: line.text,
			oldLine: line.oldLine,
			newLine: line.newLine,
			diffPosition: line.diffPosition,
			hunkHeader: line.hunkHeader,
		})),
	}
}
