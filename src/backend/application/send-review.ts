import path from 'node:path'

import { readStagedSnapshot } from './reconcile.js'
import { buildReviewResult } from './review-result.js'

import type { ReviewResult } from '../../contracts/agent.js'
import type { ReviewerSave } from '../../contracts/browser.js'
import type { Decision, ReviewComment, ReviewState } from '../domain/review.js'
import type { GitPort, ReviewStorePort } from './ports.js'

const JSON_INDENT = 2

export type SentReview = {
	// The desk's next state root: the reviewer slice, the staged snapshot, and the persist
	// stamp folded into a NEW root (copy-on-write; unchanged branches shared by reference).
	// The caller commits it - this function never edits the live state in place.
	state: ReviewState
	resultJson: string
	reviewResult: ReviewResult
}

// The reviewer-owned patch a save/send applies. The inbound route's DTO decode
// (parseReviewerSave in the http adapter, keyed off reviewerSavePatch below) has already
// shaped the raw body into these domain records - a malformed patch is refused there (422),
// never applied to the review state. Absent keys are left untouched (snapshot semantics,
// latest wins: a stale open tab may POST the whole old ReviewState).
export type ReviewerSavePatch = {
	decisions?: Decision[]
	comments?: ReviewComment[]
	reviewedFiles?: string[]
	reviewedFileHashes?: Record<string, string>
	decisionFiles?: string[]
}

// The reviewer-owned slice a save/send body carries: { decisions, comments, reviewedFiles,
// reviewedFileHashes, decisionFiles }. Only these fields are mutated from the browser; everything
// else (rawDiff, file contents, changes, guide, desk metadata) stays server-authoritative. We pick
// each key from whatever body arrives and replace wholesale - picking (rather than assigning the
// raw body) is what lets a stale open tab keep working: it may POST the whole old ReviewState,
// and we simply ignore everything but these. This key policy is THE single source: the inbound
// transport decodes exactly these keys off it.
const REVIEWER_SAVE_KEYS = [
	'decisions',
	'comments',
	'reviewedFiles',
	'reviewedFileHashes',
	'decisionFiles',
] as const satisfies ReadonlyArray<keyof ReviewerSave>

// The reviewer-owned keys of a raw body, or {} when it isn't a JSON object. The KEY-level
// allowlist for the slice; record-level DTO validation lives with the inbound transport
// (parseReviewerSave), which decodes into ReviewerSavePatch before anything reaches a use case.
export function reviewerSavePatch(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== 'object') return {}
	const posted: Record<string, unknown> = { ...body }
	return Object.fromEntries(
		REVIEWER_SAVE_KEYS.filter(key => posted[key] !== undefined).map(key => [
			key,
			posted[key],
		]),
	)
}

// The one applier for a decoded reviewer save (both /api/save and /api/send): only PRESENT
// keys replace - absent keys mean "unchanged" - and each key is spelled against ReviewState,
// so no raw or unknown patch can ever reach the state.
export function applyReviewerSave(
	state: ReviewState,
	patch: ReviewerSavePatch,
): ReviewState {
	return {
		...state,
		decisions: patch.decisions ?? state.decisions,
		comments: patch.comments ?? state.comments,
		reviewedFiles: patch.reviewedFiles ?? state.reviewedFiles,
		reviewedFileHashes:
			patch.reviewedFileHashes ?? state.reviewedFileHashes,
		decisionFiles: patch.decisionFiles ?? state.decisionFiles,
	}
}

// The collaborator ports a Send drives: git (the staged snapshot) and the review store
// (persist the review, write the agent-facing result artifact).
export type SendIo = { git: GitPort; store: ReviewStorePort }

// The decoded save patch (DTO-validated by the inbound route) and the reviewer's ephemeral
// overall note, both extracted from the Send body.
export type SendInput = { patch: ReviewerSavePatch; overallNote: string }

// The reviewer hit Send: fold the reviewer slice and the staged snapshot into a new state
// root, persist the review, and write the agent-facing result artifact next to it. Building
// the result is what the agent contract hands over; emitting the review event is the caller's
// job, and only after the reviewer's response has flushed.
export async function sendReview(
	state: ReviewState,
	io: SendIo,
	input: SendInput,
): Promise<SentReview> {
	const merged = applyReviewerSave(state, input.patch)
	const snapshot = await readStagedSnapshot(merged, io.git)
	const persisted = await io.store.persistReview({ ...merged, ...snapshot })
	const saved: ReviewState = {
		...merged,
		...snapshot,
		...persisted.stamp,
	}
	const sessionDir = path.dirname(persisted.file)
	const resultJson = path.join(sessionDir, `${saved.id}-result.json`)
	const reviewResult = buildReviewResult(
		saved,
		{ resultJson, sessionDir },
		input.overallNote,
	)
	await io.store.writeFileAtomic(
		resultJson,
		`${JSON.stringify(reviewResult, null, JSON_INDENT)}\n`,
	)
	return { state: saved, resultJson, reviewResult }
}

// overallNote is an ephemeral, per-Send instruction threaded straight into the result -
// reviewerSavePatch never copies it onto `state`, so it is never persisted.
