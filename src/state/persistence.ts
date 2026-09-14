import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { reviewDir } from './desk.js'
import { nowIso } from './identity.js'

import type { ReviewState, ReviewerSave } from '../types.js'

const JSON_INDENT = 2
const REVIEW_FILE_SUFFIX = '.json'

// Merge the reviewer-owned slice posted to /api/save onto the live state. Only these
// fields are mutated from the browser; everything else (rawDiff, files, changes, guide,
// desk metadata) stays server-authoritative. We pick each key from whatever body arrives
// and replace wholesale (snapshot semantics, latest wins) - a key absent from the body is
// left untouched. Picking (rather than Object.assign of the raw body) is what lets a stale
// open tab keep working: it may POST the whole old ReviewState, and we simply ignore
// everything but these.
const REVIEWER_SAVE_KEYS = [
	'decisions',
	'comments',
	'reviewedFiles',
	'reviewedFileHashes',
	'decisionFiles',
] as const satisfies ReadonlyArray<keyof ReviewerSave>

// The reviewer-owned patch a /api/save body carries, or {} when it isn't a JSON object. Returned
// rather than applied: the caller owns the live state and merges the patch onto it.
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

function reviewFileName(state: ReviewState): string {
	return `${state.createdAt.replace(/[:.]/g, '-')}-${state.id}${REVIEW_FILE_SUFFIX}`
}

// Write via a same-directory temp file + rename so a desk killed mid-write never leaves a truncated
// review behind: the rename is atomic on one filesystem, so a reader sees either the whole old file
// or the whole new one, never a half. Same dir keeps source and target on the same filesystem.
export async function writeFileAtomic(
	file: string,
	contents: string,
): Promise<void> {
	const tmp = `${file}.${crypto.randomUUID()}.tmp`
	await fs.writeFile(tmp, contents, 'utf8')
	await fs.rename(tmp, file)
}

// The bookkeeping a persisted file carries about itself: when it was written, and the name it was
// written under (so the next save overwrites the same file).
export type ReviewStamp = { updatedAt: string; persistFile: string }

export type PersistedReview = { file: string; stamp: ReviewStamp }

// Write the review to its file and hand back the stamp it carries. The caller adopts the stamp onto
// its live state - the review object identity is the desk's (its long-poll handlers and poll
// responses read it), so a persist must not mutate the argument it is given.
export async function persistReview(
	state: ReviewState,
): Promise<PersistedReview> {
	const dir = await reviewDir(state.root, state.session)
	const file = path.join(dir, state.persistFile ?? reviewFileName(state))
	const stamp: ReviewStamp = {
		updatedAt: nowIso(),
		persistFile: path.basename(file),
	}
	await writeFileAtomic(
		file,
		`${JSON.stringify({ ...state, ...stamp }, null, JSON_INDENT)}\n`,
	)
	return { file, stamp }
}

export async function loadLatestReview(
	root: string,
	session: string,
): Promise<ReviewState | null> {
	const dir = await reviewDir(root, session)
	const entries = await fs.readdir(dir).catch(() => [])
	const newestFirst = entries
		.filter(name => name.endsWith(REVIEW_FILE_SUFFIX))
		.toSorted()
		.toReversed()
	return await loadNewestFor(
		newestFirst.map(name => path.join(dir, name)),
		root,
	)
}

// Read the candidates newest-first, stopping at the first holding a state for THIS root. Lazy on
// purpose: a session dir can accumulate one file per desk launch, and only the newest matching state
// is wanted (a state for another root means a hash collision - keep looking).
async function loadNewestFor(
	candidates: string[],
	root: string,
): Promise<ReviewState | null> {
	const [file, ...older] = candidates
	if (!file) return null
	const state = await readReviewFile(file)
	if (state.root === root) return state
	return await loadNewestFor(older, root)
}

// A persisted review, padded with the collections older or partially-written files may lack. The
// declared ReviewState type says these are always present, so the widening below is deliberate: this
// is the one place that reads a review file that was not written by this process.
async function readReviewFile(file: string): Promise<ReviewState> {
	const state: ReviewState = JSON.parse(await fs.readFile(file, 'utf8'))
	state.persistFile = path.basename(file)
	state.comments = orEmpty(state.comments)
	state.changes = orEmpty(state.changes)
	state.reviewedFiles = orEmpty(state.reviewedFiles)
	state.stagedFiles = orEmpty(state.stagedFiles)
	return state
}

function orEmpty<Stored>(stored: Stored[] | undefined): Stored[] {
	return stored ?? []
}
