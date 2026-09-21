import { changeKey } from '../domain/change-blocks.js'
import { reanchorComments } from '../domain/comments.js'
import { effectiveDecisions } from '../domain/decisions.js'

import { mapContentReads } from './content-reads.js'
import { readFileContents } from './contents.js'

import type { FileContents } from '../domain/contents.js'
import type {
	ChangeState,
	Decision,
	ReviewComment,
	ReviewFile,
	ReviewState,
} from '../domain/review.js'
import type { GitPort } from './ports.js'

// How one reload's git-native renames map the reviewer's records onto the rebuilt diff.
type RenameMigration = {
	// The new path a recorded path moved to, or the same path when it didn't move.
	migratePath: (path: string) => string
	// A `path:stableKey` key whose path prefix was renamed - prefix swapped, stableKey kept.
	migrateKey: (key: string) => string
}

// Reconcile a freshly-built base with the state a previous round saved: carry the reviewer's
// decisions, sign-offs, comments and staged bookkeeping onto the new diff, and hand back the merged
// state (the caller replaces its live state with it). Content hashes decide what survives - see
// mergeDecisions / carryReviewedFiles - so a rewritten block or file falls back to pending.
export async function mergeReviewState(
	base: ReviewState,
	saved: ReviewState | null,
	git: GitPort,
): Promise<ReviewState> {
	if (!saved) return base
	const rename = renameMigration(base.files)
	const signOff = carryReviewedFiles(base, saved, rename)
	const decisions = mergeDecisions(base, saved, rename)
	return {
		...base,
		id: saved.id,
		createdAt: saved.createdAt,
		comments: await mergeComments(base, saved, rename, git),
		reviewedFiles: signOff.reviewedFiles,
		reviewedFileHashes: signOff.reviewedFileHashes,
		stagedFiles: saved.stagedFiles,
		// Migrate staged-hunk keys old→new too, so a working-mode pair's pre-rename key doesn't linger
		// stale after the rename appears (readStagedSnapshot later prunes keys whose file isn't staged).
		stagedChangeKeys: (saved.stagedChangeKeys ?? []).map(rename.migrateKey),
		decisionFiles: (saved.decisionFiles ?? []).map(rename.migratePath),
		changes: decisions.changes,
		decisions: decisions.decisions,
		// Carry the attached guide forward across reload/restart (the rebuilt base has none).
		guide: saved.guide ?? base.guide,
		persistFile: saved.persistFile,
	} satisfies ReviewState
}

// A file that became a git-native rename on THIS reload arrives at its new path, but every
// decision/comment/sign-off the reviewer recorded before the rename is keyed to the old path. That
// mismatch is guaranteed on every rename (unlike ordinary content staleness), so without remapping,
// those records silently drop (comment path miss) or reset to pending (decision key miss) the
// moment the rename appears. Remap old→new up front; the stableKey/contentHash/anchor checks then
// judge staleness on the real content as usual. (Reused by issues 02/03 for working-mode move
// pairing and guide-declared merges.)
function renameMigration(files: readonly ReviewFile[]): RenameMigration {
	const renamed = new Map<string, string>()
	for (const file of files) {
		if (file.oldPath && file.newPath && file.oldPath !== file.newPath)
			renamed.set(file.oldPath, file.newPath)
	}
	return {
		migratePath: path => renamed.get(path) ?? path,
		migrateKey: key => {
			for (const [oldPath, newPath] of renamed) {
				if (key.startsWith(`${oldPath}:`))
					return `${newPath}:${key.slice(oldPath.length + 1)}`
			}
			return key
		},
	}
}

// Decisions are explicit and durable: carry them forward as the source of truth. A decision whose
// change is gone from the rebuilt diff (e.g. accepting it staged the hunk out of the working tree)
// is *kept* - that's the whole point. A decision whose change is still visible but whose content
// changed is dropped as stale. An accepted decision whose change vanished is kept (accepting may
// have staged the hunk out of the diff). A REJECTED decision whose change vanished means the agent
// reworked the block away - the rejection was honored, and keeping it would leave an invisible
// objection that blocks approval forever. Drop it; whatever replaced the block shows up as a fresh
// pending change anyway.
function mergeDecisions(
	base: ReviewState,
	saved: ReviewState,
	rename: RenameMigration,
): { changes: ChangeState[]; decisions: Decision[] } {
	const migrated = effectiveDecisions(saved).map(decision =>
		renamedDecision(decision, rename),
	)
	const decisionByKey = new Map(
		migrated.map(decision => [decision.key, decision]),
	)
	const stale = new Set<string>()
	// ChangeState records are readonly domain data - a surviving decision is applied
	// by producing a new change record here, never by editing the base record in place.
	const statusByKey = new Map<
		string,
		Pick<ChangeState, 'status' | 'reviewedHash'>
	>()
	for (const change of base.changes) {
		const key = changeKey(change)
		const decision = decisionByKey.get(key)
		if (!decision) continue
		if (
			decision.reviewedHash &&
			decision.reviewedHash === change.contentHash
		) {
			statusByKey.set(key, {
				status: decision.status,
				reviewedHash: decision.reviewedHash,
			})
			continue
		}
		stale.add(key) // agent rewrote this block since it was reviewed → re-review
	}
	const changes = base.changes.map(change => {
		const applied = statusByKey.get(changeKey(change))
		return applied ? { ...change, ...applied } : change
	})
	const present = new Set(base.changes.map(change => changeKey(change)))
	return {
		changes,
		decisions: migrated.filter(
			decision =>
				!stale.has(decision.key) &&
				(decision.status !== 'rejected' || present.has(decision.key)),
		),
	}
}

function renamedDecision(
	decision: Decision,
	rename: RenameMigration,
): Decision {
	const path = rename.migratePath(decision.path)
	if (path === decision.path) return decision
	return { ...decision, path, key: rename.migrateKey(decision.key) }
}

// A file's approval/sign-off survives reload only if the file is still present AND its content hash
// is unchanged. A file whose content the agent rewrote (or that has no recorded hash - e.g. an old
// "viewed" session) drops back to pending for re-review. Sign-off + its hash also migrate old→new (a
// pure rename keeps the content hash, so approval survives; a rename+edit fails the hash check below
// and re-reviews, as any content change does).
function carryReviewedFiles(
	base: ReviewState,
	saved: ReviewState,
	rename: RenameMigration,
): Pick<ReviewState, 'reviewedFiles' | 'reviewedFileHashes'> {
	const currentHashes = new Map(
		base.files.map(file => [file.path, file.contentHash]),
	)
	const savedHashes = Object.fromEntries(
		Object.entries(saved.reviewedFileHashes ?? {}).map(
			([path, fileHash]) => [rename.migratePath(path), fileHash],
		),
	)
	const reviewedFiles: string[] = []
	const reviewedFileHashes: Record<string, string> = {}
	for (const savedPath of saved.reviewedFiles) {
		const file = rename.migratePath(savedPath)
		const savedHash = savedHashes[file]
		if (!savedHash || currentHashes.get(file) !== savedHash) continue
		reviewedFiles.push(file)
		reviewedFileHashes[file] = savedHash
	}
	return { reviewedFiles, reviewedFileHashes }
}

// The reviewer's comments on the new diff: rename-migrated, marked stale (and dropped unless they
// are change requests) when their file is gone, then re-anchored against live contents.
async function mergeComments(
	base: ReviewState,
	saved: ReviewState,
	rename: RenameMigration,
	git: GitPort,
): Promise<ReviewComment[]> {
	const currentFiles = new Set(base.files.map(file => file.path))
	const comments = saved.comments
		.map(comment => renamedComment(comment, rename))
		.map(comment => markStaleIfGone(comment, currentFiles))
		.filter(
			comment =>
				currentFiles.has(comment.path) || comment.intent === 'action',
		)
	const openPaths = new Set(
		comments
			.filter(comment => comment.status === 'open')
			.map(comment => comment.path),
	)
	const contentsByPath = await readCommentedContents(base, openPaths, git)
	return reanchorComments(comments, base.files, path =>
		contentsByPath.get(path),
	)
}

function renamedComment(
	comment: ReviewComment,
	rename: RenameMigration,
): ReviewComment {
	const path = rename.migratePath(comment.path)
	if (path === comment.path) return comment
	return { ...comment, path }
}

function markStaleIfGone(
	comment: ReviewComment,
	currentFiles: Set<string>,
): ReviewComment {
	if (currentFiles.has(comment.path)) return comment
	return { ...comment, status: 'stale' }
}

// Re-anchoring reads each commented file's contents on demand (the state embeds none). Fetch only
// the files carrying an OPEN comment - the set reanchorComments actually processes - so a reload
// spawns at most one content read per commented file, not per file in the diff. A read that fails
// (a git object dropped mid-reload) is swallowed to no-contents: the thread just falls to the
// file-level unanchored strip rather than crashing the whole reload. Read them concurrently - each is
// an independent `git show` spawn, so awaiting them one at a time serialized the whole set behind
// the slowest read on every reload.
async function readCommentedContents(
	base: ReviewState,
	openPaths: Set<string>,
	git: GitPort,
): Promise<Map<string, FileContents>> {
	const contentsByPath = new Map<string, FileContents>()
	const commented = base.files.filter(file => openPaths.has(file.path))
	await mapContentReads(commented, async file => {
		const resolved = await readFileContents(base, file, git).catch(
			() => undefined,
		)
		if (resolved) contentsByPath.set(file.path, resolved)
	})
	return contentsByPath
}

// The two index-derived collections readStagedSnapshot always hands back - both present, so a caller
// can compare a snapshot's fields field-by-field without a `?? []` on its own side.
export type StagedSnapshot = Required<
	Pick<ReviewState, 'stagedFiles' | 'stagedChangeKeys'>
>

// Reflect the live index onto the review: which reviewed files are staged now, and the staged-hunk
// bookkeeping pruned to keys whose file is still staged (declaring a hunk staged is only meaningful
// while its file is). Returns the snapshot; the caller owns the live state and applies it.
export async function readStagedSnapshot(
	state: ReviewState,
	git: GitPort,
): Promise<StagedSnapshot> {
	const staged = await git
		.run(['diff', '--cached', '--name-only'], state.root)
		.catch(() => '')
	const stagedFiles = new Set(staged.split(/\r?\n/).filter(Boolean))
	const reviewFiles = new Set(state.files.map(file => file.path))
	return {
		stagedFiles: [...stagedFiles].filter(file => reviewFiles.has(file)),
		stagedChangeKeys: (state.stagedChangeKeys ?? []).filter(key =>
			stagedFiles.has(key.split(':')[0]),
		),
	}
}
