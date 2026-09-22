// The review boundary's wire→model mappers: the only place /api/state and /api/poll
// payloads are decoded onto the frontend-owned models (model.ts). Required fields fail
// loudly with a named boundary error; unknown response properties are ignored by
// construction (only what's read below is copied), so newer desks stay usable.

import {
	assertObject,
	requiredArray,
	requiredBoolean,
	requiredNumber,
	requiredString,
	requiredStringArray,
	optBoolean,
	optEnum,
	optNumber,
	optString,
	enumValue,
} from '@shared/api/decode'
import { DecodeError } from '@shared/api/decode'

import type {
	ChangeState,
	Decision,
	DeskPollSnapshot,
	DeskRefreshEvent,
	DeskStateSnapshot,
	DeskStatus,
	Guide,
	ReviewComment,
	ReviewFile,
	ReviewState,
} from './model'

const MODES = ['repo', 'file', 'pr'] as const
const SIDES = ['additions', 'deletions'] as const
const COMMENT_STATUSES = ['open', 'resolved', 'stale'] as const
const CHANGE_STATUSES = ['pending', 'accepted', 'rejected'] as const
const DECISION_STATUSES = ['accepted', 'rejected'] as const
const INTENTS = ['note', 'action', 'question'] as const
const ROLES = ['user', 'agent'] as const
const CHANGE_KINDS = ['added', 'modified', 'deleted', 'renamed'] as const

type Ctx = { endpoint: string }

export function decodeComment(raw: unknown, ctx: Ctx): ReviewComment {
	const o = assertObject(raw, ctx.endpoint, 'comment')
	return {
		id: requiredString(o, 'id', ctx.endpoint),
		path: requiredString(o, 'path', ctx.endpoint),
		side: enumValue(o.side, ctx.endpoint, SIDES, 'comment.side'),
		lineNumber: requiredNumber(o, 'lineNumber', ctx.endpoint),
		endLine: optNumber(o, 'endLine', ctx.endpoint),
		body: requiredString(o, 'body', ctx.endpoint),
		createdAt: requiredString(o, 'createdAt', ctx.endpoint),
		updatedAt: requiredString(o, 'updatedAt', ctx.endpoint),
		status: enumValue(
			o.status,
			ctx.endpoint,
			COMMENT_STATUSES,
			'comment.status',
		),
		intent: optEnum(o, 'intent', ctx.endpoint, INTENTS),
		role: optEnum(o, 'role', ctx.endpoint, ROLES),
		anchorText: optString(o, 'anchorText', ctx.endpoint),
		unanchored: optBoolean(o, 'unanchored', ctx.endpoint),
		anchor: optEnum(o, 'anchor', ctx.endpoint, ['file'] as const),
	}
}

export function decodeChange(raw: unknown, ctx: Ctx): ChangeState {
	const o = assertObject(raw, ctx.endpoint, 'change')
	return {
		id: requiredString(o, 'id', ctx.endpoint),
		path: requiredString(o, 'path', ctx.endpoint),
		hunkIndex: requiredNumber(o, 'hunkIndex', ctx.endpoint),
		changeIndex: optNumber(o, 'changeIndex', ctx.endpoint),
		side: enumValue(o.side, ctx.endpoint, SIDES, 'change.side'),
		lineNumber: requiredNumber(o, 'lineNumber', ctx.endpoint),
		endLine: optNumber(o, 'endLine', ctx.endpoint),
		title: requiredString(o, 'title', ctx.endpoint),
		stableKey: optString(o, 'stableKey', ctx.endpoint),
		status: enumValue(
			o.status,
			ctx.endpoint,
			CHANGE_STATUSES,
			'change.status',
		),
		stageable: optBoolean(o, 'stageable', ctx.endpoint),
		contentHash: optString(o, 'contentHash', ctx.endpoint),
		reviewedHash: optString(o, 'reviewedHash', ctx.endpoint),
		displayLineNumber: optNumber(o, 'displayLineNumber', ctx.endpoint),
		displayEndLine: optNumber(o, 'displayEndLine', ctx.endpoint),
	}
}

export function decodeDecision(raw: unknown, ctx: Ctx): Decision {
	const o = assertObject(raw, ctx.endpoint, 'decision')
	return {
		key: requiredString(o, 'key', ctx.endpoint),
		status: enumValue(
			o.status,
			ctx.endpoint,
			DECISION_STATUSES,
			'decision.status',
		),
		reviewedHash: optString(o, 'reviewedHash', ctx.endpoint),
		path: requiredString(o, 'path', ctx.endpoint),
		lineNumber: requiredNumber(o, 'lineNumber', ctx.endpoint),
		side: enumValue(o.side, ctx.endpoint, SIDES, 'decision.side'),
		title: requiredString(o, 'title', ctx.endpoint),
	}
}

function decodeGuide(raw: unknown, ctx: Ctx): Guide {
	const o = assertObject(raw, ctx.endpoint, 'guide')
	const files = requiredArray(o, 'files', ctx.endpoint, 'guide.files')
	return {
		files: files.map(f => {
			const g = assertObject(f, ctx.endpoint, 'guide file')
			return {
				path: requiredString(g, 'path', ctx.endpoint),
				order: requiredNumber(g, 'order', ctx.endpoint),
				category: requiredString(g, 'category', ctx.endpoint),
			}
		}),
		baseDiffHash: optString(o, 'baseDiffHash', ctx.endpoint),
	}
}

export function decodeReviewFile(raw: unknown, ctx: Ctx): ReviewFile {
	const o = assertObject(raw, ctx.endpoint, 'file')
	return {
		path: requiredString(o, 'path', ctx.endpoint),
		oldPath: optString(o, 'oldPath', ctx.endpoint),
		newPath: optString(o, 'newPath', ctx.endpoint),
		contentHash: requiredString(o, 'contentHash', ctx.endpoint),
		changeKind: optEnum(o, 'changeKind', ctx.endpoint, CHANGE_KINDS),
		renamePure: optBoolean(o, 'renamePure', ctx.endpoint),
		oversized: optBoolean(o, 'oversized', ctx.endpoint),
		size: optNumber(o, 'size', ctx.endpoint),
		added: requiredNumber(o, 'added', ctx.endpoint),
		removed: requiredNumber(o, 'removed', ctx.endpoint),
		hasHunks: requiredBoolean(o, 'hasHunks', ctx.endpoint),
	}
}

export function decodeReviewState(raw: unknown, endpoint: string): ReviewState {
	const ctx = { endpoint }
	const o = assertObject(raw, endpoint, 'review state')
	let guide: Guide | undefined
	const rawGuide = o.guide
	if (rawGuide) guide = decodeGuide(rawGuide, ctx)
	return {
		root: requiredString(o, 'root', endpoint),
		session: requiredString(o, 'session', endpoint),
		mode: enumValue(o.mode, endpoint, MODES, 'review state.mode'),
		target: optString(o, 'target', endpoint),
		staged: requiredBoolean(o, 'staged', endpoint),
		baseDiffHash: requiredString(o, 'baseDiffHash', endpoint),
		changes: requiredArray(o, 'changes', endpoint, 'changes').map(c =>
			decodeChange(c, ctx),
		),
		comments: requiredArray(o, 'comments', endpoint, 'comments').map(c =>
			decodeComment(c, ctx),
		),
		decisions: o.decisions
			? requiredArray(o, 'decisions', endpoint, 'decisions').map(d =>
					decodeDecision(d, ctx),
				)
			: undefined,
		guide,
		reviewedFiles: requiredStringArray(o, 'reviewedFiles', endpoint),
		reviewedFileHashes: decodeStringRecord(
			o,
			'reviewedFileHashes',
			endpoint,
		),
		stagedFiles: requiredStringArray(o, 'stagedFiles', endpoint),
		stagedChangeKeys: o.stagedChangeKeys
			? requiredStringArray(o, 'stagedChangeKeys', endpoint)
			: undefined,
		decisionFiles: o.decisionFiles
			? requiredStringArray(o, 'decisionFiles', endpoint)
			: undefined,
		files: requiredArray(o, 'files', endpoint, 'files').map(f =>
			decodeReviewFile(f, ctx),
		),
	}
}

function decodeStringRecord(
	o: Record<string, unknown>,
	key: string,
	endpoint: string,
): Record<string, string> | undefined {
	if (!o[key]) return undefined
	const raw = assertObject(o[key], endpoint, key)
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v !== 'string')
			throw new DecodeError(`${key}.${k} is not a string`, endpoint)
		out[k] = v
	}
	return out
}

export function decodeDeskStatus(
	o: Record<string, unknown>,
	endpoint: string,
): DeskStatus {
	const activity = o.agentActivity
	let agentActivity: DeskStatus['agentActivity'] = null
	if (activity) {
		const a = assertObject(activity, endpoint, 'agentActivity')
		agentActivity = {
			body: requiredString(a, 'body', endpoint),
			at: requiredString(a, 'at', endpoint),
		}
	}
	return {
		agentActivity,
		agentListening: requiredBoolean(o, 'agentListening', endpoint),
		queuedQuestions: requiredNumber(o, 'queuedQuestions', endpoint),
		queuedReviews: requiredNumber(o, 'queuedReviews', endpoint),
	}
}

// GET /api/state: the review state plus the desk's liveness fields. Liveness is kept
// OUT of the adopted review (the caller strips it - see poll.ts adoptDeskStatus); here
// it is validated only.
export function decodeDeskStateSnapshot(
	raw: unknown,
	endpoint: string,
): DeskStateSnapshot {
	const o = assertObject(raw, endpoint, 'review state')
	const state = decodeReviewState(o, endpoint)
	const status = decodeDeskStatus(o, endpoint)
	return {
		...state,
		...status,
		serverInstanceId: optString(o, 'serverInstanceId', endpoint),
	}
}

// GET /api/poll: the hash/guide/comments tick plus desk liveness, or a refresh event
// after a restart. DeskStatus rides both (see src/contracts/browser.ts).
export function decodePollPayload(
	raw: unknown,
	endpoint: string,
): (DeskPollSnapshot & DeskStatus) | DeskRefreshEvent {
	const o = assertObject(raw, endpoint, 'poll payload')
	if (o.kind === 'refresh') return { kind: 'refresh' }
	const ctx = { endpoint }
	let guide: Guide | undefined
	if (o.guide) guide = decodeGuide(o.guide, ctx)
	return {
		baseDiffHash: requiredString(o, 'baseDiffHash', endpoint),
		guide,
		comments: requiredArray(o, 'comments', endpoint, 'comments').map(c =>
			decodeComment(c, ctx),
		),
		...decodeDeskStatus(o, endpoint),
	}
}
