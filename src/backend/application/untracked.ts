import path from 'node:path'

import { blobOid } from '../domain/identity.js'

import { mapContentReads } from './content-reads.js'
import { fileEntry } from './diff-files.js'

import type { ChangeState, ReviewFile } from '../domain/review.js'
import type { GitPort } from './ports.js'

// What the scan needs to know: the repo root and the optional `--path` limit the diff was taken
// with (untracked files must obey the same limit, or a scoped review would grow silently).
export type UntrackedScan = { root: string; path?: string }

type UntrackedEntry = { rel: string; working: string }

// The halves a pairing pass resolved: merged rename entries to add, plus the deletion paths and
// untracked paths it consumed (so neither is rendered a second time).
type UntrackedPairing = {
	moves: ReviewFile[]
	deletedPaths: Set<string>
	untrackedPaths: Set<string>
}

// `git diff` never reports untracked files (a brand-new file has no index/HEAD side to diff
// against), so the working review would silently drop any file the agent created but never `git
// add`ed. Surface them as full-file additions - same representation as file mode. They carry no
// stageable hunks; whole-file Approve stages them via `git add` (/api/stage), which doesn't rely on
// rawDiff. Staged mode is unaffected: untracked files are by definition not in the index.
export async function appendUntrackedFiles(
	files: ReviewFile[],
	changes: ChangeState[],
	scan: UntrackedScan,
	git: GitPort,
): Promise<void> {
	const entries = await readUntrackedEntries(scan, git)
	const pairing = await pairUntrackedMoves(scan.root, files, entries, git)
	dropPairedDeletions(files, changes, pairing.deletedPaths)
	for (const entry of entries) {
		if (pairing.untrackedPaths.has(entry.rel)) continue
		files.push(fileEntry(entry.rel, '', entry.working))
	}
	files.push(...pairing.moves)
}

async function readUntrackedEntries(
	scan: UntrackedScan,
	git: GitPort,
): Promise<UntrackedEntry[]> {
	const args = ['ls-files', '--others', '--exclude-standard']
	if (scan.path) args.push('--', scan.path)
	const untracked = (await git.run(args, scan.root))
		.split(/\r?\n/)
		.filter(Boolean)
	// A file that vanished between the listing and the read (or is unreadable) reads as empty, which
	// leaves it an ordinary full addition rather than failing the whole review.
	return await mapContentReads(untracked, async rel => ({
		rel,
		working:
			(await git.workspace.readFile(path.join(scan.root, rel))) ?? '',
	}))
}

// Pair identical-content moves git can't see: a plain `mv` shows as a full deletion of the tracked
// file (`+++ /dev/null`, so newPath is undefined) PLUS a full untracked addition. When a deleted
// file's index (:0) content is byte-identical to exactly one untracked file - and that untracked
// file matches exactly one deletion - it's an unambiguous rename. Merge the halves into one
// rename-pure entry (issue 01's muted row / Renamed-fold / progress exclusion, no new UI) rather
// than making the reviewer re-read the whole file as a delete + re-add. Any ambiguity (2+ identical
// candidates on either side) pairs nothing and leaves today's delete+add rendering. Exact bytes only
// - a moved-AND-edited file is deliberately NOT paired (that's guide movedFrom, issue 03). This runs
// before the base becomes mergeReviewState's input, so a merged entry's distinct old/new paths get
// issue 01's decision/comment migration for free. Keyed by blob OID - byte-identical contents share
// an OID, so the map pairs a deletion with an untracked file exactly when git would call it a rename
// (OID equality iff content equal). Skip the reads entirely when there's nothing untracked to pair.
async function pairUntrackedMoves(
	root: string,
	files: ReviewFile[],
	entries: UntrackedEntry[],
	git: GitPort,
): Promise<UntrackedPairing> {
	const pairing: UntrackedPairing = {
		moves: [],
		deletedPaths: new Set(),
		untrackedPaths: new Set(),
	}
	if (!entries.length) return pairing
	const untByOid = untrackedByOid(entries)
	// The deletion's old side lives in the index (:0); read it just to hash for pairing (a read, not
	// retained - the merged entry stores no contents; the tab fetches them on open).
	const delByOid = await deletionsByOid(
		root,
		files.filter(file => !file.newPath),
		git,
	)
	for (const [oid, deletions] of delByOid) {
		const untracked = untByOid.get(oid)
		if (deletions.length !== 1 || untracked?.length !== 1) continue // unique 1:1 match only
		const [deletion] = deletions
		const [entry] = untracked
		pairing.moves.push(mergeMove(deletion, entry))
		pairing.deletedPaths.add(deletion.path)
		pairing.untrackedPaths.add(entry.rel)
	}
	return pairing
}

// The merged half: the untracked path with the deleted path recorded as its old side. Byte-identical
// content → a pure rename (the muted moved row / Renamed fold). No contents retained; the new
// side's OID is hashed from the working copy already read.
function mergeMove(deletion: ReviewFile, entry: UntrackedEntry): ReviewFile {
	return {
		path: entry.rel,
		oldPath: deletion.path,
		newPath: entry.rel,
		hunks: [],
		contentHash: blobOid(entry.working),
		changeKind: 'renamed',
		renamePure: true,
		added: 0,
		removed: 0,
		size: Buffer.byteLength(entry.working, 'utf8'),
	}
}

async function deletionsByOid(
	root: string,
	deletions: ReviewFile[],
	git: GitPort,
): Promise<Map<string, ReviewFile[]>> {
	const hashed = await mapContentReads(deletions, async deletion => ({
		deletion,
		oid: blobOid(
			await git.fileAt(root, deletion.oldPath ?? deletion.path, ':0'),
		),
	}))
	const byOid = new Map<string, ReviewFile[]>()
	for (const { deletion, oid } of hashed) pushGroup(byOid, oid, deletion)
	return byOid
}

function untrackedByOid(
	entries: UntrackedEntry[],
): Map<string, UntrackedEntry[]> {
	const byOid = new Map<string, UntrackedEntry[]>()
	for (const entry of entries) pushGroup(byOid, blobOid(entry.working), entry)
	return byOid
}

function pushGroup<Grouped>(
	groups: Map<string, Grouped[]>,
	oid: string,
	member: Grouped,
): void {
	const group = groups.get(oid)
	if (group) group.push(member)
	else groups.set(oid, [member])
}

// Drop the paired deletions + their change blocks; unpaired untracked files stay full additions.
function dropPairedDeletions(
	files: ReviewFile[],
	changes: ChangeState[],
	deletedPaths: Set<string>,
): void {
	if (!deletedPaths.size) return
	for (let i = files.length - 1; i >= 0; i--) {
		if (files[i].newPath) continue
		if (deletedPaths.has(files[i].path)) files.splice(i, 1)
	}
	for (let i = changes.length - 1; i >= 0; i--) {
		if (deletedPaths.has(changes[i].path)) changes.splice(i, 1)
	}
}
