import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { AdapterError, errorMessage } from '../../../application/errors.js'
import { nowIso } from '../../../application/time.js'

import { reviewDir } from './desk.js'
import { decodeReviewFile, encodeReviewFile } from './diff-envelope-dto.js'
import { asString } from './dto.js'
import {
	decodeChange,
	decodeComment,
	decodeDecision,
	decodeGuide,
	decodeReviewStateFile,
	encodeChange,
	encodeComment,
	encodeDecision,
	encodeGuide,
} from './review-file-dto.js'

import type {
	PersistedReview,
	ReviewStamp,
	ReviewStorePort,
} from '../../../application/ports.js'
import type { ReviewState } from '../../../domain/review.js'
import type { Raw } from './dto.js'

const JSON_INDENT = 2
const REVIEW_FILE_SUFFIX = '.json'

// Transport DTO validation for the /api/save body lives with the inbound HTTP route
// (parseReviewerSave in the http adapter); this adapter's storage contract lives in
// review-file-dto.ts and only whole reviews cross it.

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
	try {
		await fs.writeFile(tmp, contents, 'utf8')
		await fs.rename(tmp, file)
	} catch (error) {
		throw new AdapterError(errorMessage(error), { cause: error })
	}
}

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
		`${JSON.stringify(serializeReviewState(state, stamp), null, JSON_INDENT)}\n`,
	)
	return { file, stamp }
}

// The on-disk review JSON, mapped field by field - NOT the aggregate spread. Persisting
// `{...state}` would silently write any field a future desk run adds to the aggregate; this
// mapping is the explicit contract with the existing file shape (unwrapping the persisted stamp
// onto updatedAt / persistFile). Nested records go through the storage DTO encoders
// (review-file-dto.ts) rather than riding by reference, so the disk format only carries
// what the storage contract lists.
function serializeReviewState(
	state: ReviewState,
	stamp: ReviewStamp,
): Record<string, unknown> {
	return {
		id: state.id,
		session: state.session,
		root: state.root,
		repoHash: state.repoHash,
		mode: state.mode,
		target: state.target,
		base: state.base,
		staged: state.staged,
		head: state.head,
		baseDiffHash: state.baseDiffHash,
		createdAt: state.createdAt,
		updatedAt: stamp.updatedAt,
		rawDiff: state.rawDiff,
		files: state.files.map(encodeReviewFile),
		comments: state.comments.map(encodeComment),
		changes: state.changes.map(encodeChange),
		reviewedFiles: state.reviewedFiles,
		reviewedFileHashes: state.reviewedFileHashes,
		stagedFiles: state.stagedFiles,
		stagedChangeKeys: state.stagedChangeKeys,
		decisionFiles: state.decisionFiles,
		decisions: state.decisions?.map(encodeDecision),
		guide: state.guide ? encodeGuide(state.guide) : undefined,
		persistFile: stamp.persistFile,
	}
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
// is wanted (a state for another root - or a file that is not a review record at all - means keep
// looking).
//
// A CORRUPT review file (invalid JSON) ends the search: it is deleted - retain no copy, per the
// approved corrupt-review behavior - and the desk initializes from an empty review state, rather
// than resurrecting an older round the corrupt file superseded.
async function loadNewestFor(
	candidates: string[],
	root: string,
): Promise<ReviewState | null> {
	const [file, ...older] = candidates
	if (!file) return null
	const state = await readReviewFile(file)
	if (state === 'corrupt') {
		await fs.rm(file, { force: true }).catch(() => undefined)
		return null
	}
	if (state === null) return await loadNewestFor(older, root)
	if (state.root === root) return state
	return await loadNewestFor(older, root)
}

// One persisted review, decoded through the storage DTO (review-file-dto.ts): the JSON body is
// never cast to ReviewState. Collections older or partially-written files may lack are padded
// to the declared ReviewState shape; malformed nested records are dropped rather than fatal,
// so a file always loads whatever is intact. Returns 'corrupt' when the file isn't valid JSON
// (the caller deletes it and initializes empty); null when it is no review record at all (the
// loader skips the candidate).
async function readReviewFile(
	file: string,
): Promise<ReviewState | null | 'corrupt'> {
	let raw: string
	try {
		raw = await fs.readFile(file, 'utf8')
	} catch (error) {
		throw new AdapterError(errorMessage(error), { cause: error })
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return 'corrupt'
	}
	const decoded = decodeReviewStateFile(parsed)
	if (decoded === null) return null // not a review record - the loader skips the candidate
	const { id, session, root, body } = decoded
	return decodePersistedState(
		{ id, session, root },
		body,
		path.basename(file),
	)
}

// One decoded review body (identity verified by decodeReviewStateFile) mapped onto the
// declared ReviewState shape, field by field. Collections older or partially-written
// files may lack are padded to the declared shape; malformed nested records are dropped
// rather than fatal, so a file always loads whatever is intact.
function decodePersistedState(
	identity: { id: string; session: string; root: string },
	body: Raw,
	persistFile: string,
): ReviewState {
	const { id, session, root } = identity
	return {
		id,
		session,
		root,
		repoHash: typeof body.repoHash === 'string' ? body.repoHash : '',
		mode:
			body.mode === 'repo' || body.mode === 'file' || body.mode === 'pr'
				? body.mode
				: 'repo',
		target: typeof body.target === 'string' ? body.target : undefined,
		base: typeof body.base === 'string' ? body.base : undefined,
		staged: body.staged === true,
		head: typeof body.head === 'string' ? body.head : null,
		baseDiffHash:
			typeof body.baseDiffHash === 'string' ? body.baseDiffHash : '',
		createdAt:
			typeof body.createdAt === 'string' ? body.createdAt : nowIso(),
		updatedAt:
			typeof body.updatedAt === 'string' ? body.updatedAt : undefined,
		rawDiff: typeof body.rawDiff === 'string' ? body.rawDiff : '',
		files: decodeArray(body.files, decodeReviewFile),
		comments: decodeArray(body.comments, decodeComment),
		changes: decodeArray(body.changes, decodeChange),
		reviewedFiles: decodeArray(body.reviewedFiles, asString),
		reviewedFileHashes: decodeStringRecord(body.reviewedFileHashes),
		stagedFiles: decodeArray(body.stagedFiles, asString),
		stagedChangeKeys: decodeArray(body.stagedChangeKeys, asString),
		decisionFiles: decodeArray(body.decisionFiles, asString),
		decisions: decodeArray(body.decisions, decodeDecision),
		// A malformed guide decodes to nothing rather than half a grouping - the desk
		// then lists files in diff order (the no-guide behavior).
		guide: body.guide ? (decodeGuide(body.guide) ?? undefined) : undefined,
		persistFile,
	}
}

// Decode a persisted hash record ({path → contentHash}); absent or malformed → undefined
// (the field is optional on the declared shape).
function decodeStringRecord(raw: unknown): Record<string, string> | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const record: Record<string, string> = {}
	for (const [key, hash] of Object.entries(raw)) {
		if (typeof hash !== 'string') return undefined
		record[key] = hash
	}
	return record
}

// Decode a persisted array field record-by-record, dropping malformed entries and
// padding an absent/ malformed field to an empty array (the declared ReviewState shape
// says these are always present).
function decodeArray<Decoded>(
	raw: unknown,
	decode: (entry: unknown) => Decoded | null,
): Decoded[] {
	if (!Array.isArray(raw)) return []
	const values: Decoded[] = []
	for (const entry of raw) {
		const decoded = decode(entry)
		if (decoded !== null) values.push(decoded)
	}
	return values
}

// The node/filesystem implementation of the application's review-store capability
// object. Frozen: use cases see a readonly port, never this module's internals.
export const nodeReviewStore: ReviewStorePort = Object.freeze({
	loadLatestReview,
	persistReview,
	writeFileAtomic,
})
