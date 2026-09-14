import { promises as fs } from 'node:fs'
import path from 'node:path'

import { reviewerSavePatch } from '../state/persistence.js'
import { readStagedSnapshot } from '../state/reconcile.js'
import { buildReviewResult } from '../state/review-result.js'

import type { ReviewResult, ReviewState } from '../types.js'

const JSON_INDENT = 2

export type SentReview = { resultJson: string; reviewResult: ReviewResult }

// The reviewer hit Send: merge the reviewer-owned slice, fold in the staged snapshot, persist the
// review, and write the agent-facing result artifact next to it. Building the result is what the
// agent contract hands over; emitting the review event is the caller's job, and only after the
// reviewer's response has flushed.
export async function sendReview(
	state: ReviewState,
	persist: () => Promise<string>,
	payload: unknown,
): Promise<SentReview> {
	Object.assign(state, reviewerSavePatch(payload))
	Object.assign(state, await readStagedSnapshot(state))
	const file = await persist()
	const sessionDir = path.dirname(file)
	const resultJson = path.join(sessionDir, `${state.id}-result.json`)
	const reviewResult = buildReviewResult(
		state,
		{ resultJson, sessionDir },
		overallNoteOf(payload),
	)
	await fs.writeFile(
		resultJson,
		`${JSON.stringify(reviewResult, null, JSON_INDENT)}\n`,
		'utf8',
	)
	return { resultJson, reviewResult }
}

// overallNote is an ephemeral, per-Send instruction threaded straight into the result -
// reviewerSavePatch never copies it onto `state`, so it is never persisted.
function overallNoteOf(payload: unknown): string {
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!('overallNote' in payload)
	)
		return ''
	const note = payload.overallNote
	return typeof note === 'string' ? note.trim() : ''
}
