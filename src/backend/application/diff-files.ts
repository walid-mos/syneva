import { filePathOf } from '../domain/change-blocks.js'
import {
	changeBlockContent,
	changeBlocks,
	changeStableKeyFromBlock,
} from '../domain/diff/change.js'
import { blobOid } from '../domain/identity.js'
import { hash } from '../domain/identity.js'

import { mapContentReads } from './content-reads.js'

import type {
	ChangeState,
	DiffFile,
	DiffHunk,
	DiffLine,
	ReviewFile,
} from '../domain/review.js'

// Lean per-file stamps, added only when they apply: `size` for a measured working-tree new side,
// `oversized` for a file whose diff would freeze the tab (issue 05). Built by assignment rather
// than a conditional spread, so a measured 0-byte file keeps `size: 0` and an unmeasured committed
// side stays absent. Spread as-is onto a ReviewFile.
type FileFlags = { size?: number; oversized?: true }

// Oversized-file thresholds (issue 05). A file whose diff would freeze the tab if rendered is
// stamped `oversized`; the UI paints a verdict-capable summary card instead of the diff. Fixed
// defaults, not user-configurable (see the PRD) - a real desk once held a 107 MB generated JSON
// whose diff took minutes to render, and any ONE of these catches that class. All computable from
// the diff + the lean stamps alone (never re-reading a committed blob).
const OVERSIZED_DIFF_BYTES = 1_000_000 // ~1 MB of unified-diff text for the file
const OVERSIZED_CHANGED_LINES = 5_000 // added + removed lines
const OVERSIZED_FILE_BYTES = 1_000_000 // new-side byte size, only where `size` is stamped

// What buildDiffSource knows about the review it is assembling, per mode: which working side to
// read, whether the diff can be staged, and the committed OIDs it may harvest instead of reading.
export type DiffAssembly = {
	// Reads the working-tree new side to hash it. Called ONLY when there's no committed OID for the
	// file (working/file mode), so pr/staged desks invoke it zero times → zero content reads at build.
	fetchNew: (p?: string) => Promise<string>
	// Whether a block can be staged (working/staged/file-tracked modes; false for pr - verdict only).
	isStageable: boolean
	// Per-file new-side blob OIDs harvested from `git diff --raw` (committed new sides: pr's HEAD,
	// staged's index). Absent for a working-tree new side, where we hash the working copy instead.
	newOids?: Map<string, string>
	// The new side is the working tree (repo-unstaged / file mode) - its byte size is then free from
	// the bytes we read to hash. Committed sides (pr/staged) leave size unstamped (see ReviewFile.size).
	isWorkingSide?: boolean
}

// The reviewed path and the decision key live in ../domain/change-blocks.ts (pure rules the
// domain's own decision reconciliation reads).

// New-side line count the way git's `@@ -0,0 +1,N @@` and @pierre count: split on \n, dropping one
// trailing newline so a file ending in \n isn't over-counted by one. Stamps a hunk-less full-file
// add's +count (no hunk to sum) - mirrors the derivation the UI used to run over the embedded copy.
function lineCount(text: string): number {
	if (!text) return 0
	const n = text.split('\n').length
	return text.endsWith('\n') ? n - 1 : n
}

function countsForHunk(hunk: DiffHunk): { added: number; removed: number } {
	let added = 0
	let removed = 0
	for (const line of hunk.lines) {
		if (line.kind === 'add') added++
		else if (line.kind === 'delete') removed++
	}
	return { added, removed }
}

// +added / -removed line counts over every hunk of one file.
function countHunkLines(hunks: readonly DiffHunk[]): {
	added: number
	removed: number
} {
	return hunks.map(countsForHunk).reduce(
		(total, counts) => ({
			added: total.added + counts.added,
			removed: total.removed + counts.removed,
		}),
		{ added: 0, removed: 0 },
	)
}

// Approximate byte length of a file's unified-diff text from its parsed hunks (each hunk header +
// each line's +/-/space prefix + content + newline). Close enough to catch a diff that would freeze
// the tab without retaining the raw per-file section on the state.
function diffTextBytes(hunks: readonly DiffHunk[]): number {
	let bytes = 0
	for (const hunk of hunks) {
		bytes += hunk.header.length + 1
		for (const line of hunk.lines)
			bytes += Buffer.byteLength(line.text, 'utf8') + LINE_PREFIX_BYTES
	}
	return bytes
}

// A line's diff prefix plus its newline.
const LINE_PREFIX_BYTES = 2

function isOversized(
	diffBytes: number,
	changedLines: number,
	size: number | undefined,
): boolean {
	if (diffBytes > OVERSIZED_DIFF_BYTES) return true
	if (changedLines > OVERSIZED_CHANGED_LINES) return true
	return typeof size === 'number' && size > OVERSIZED_FILE_BYTES
}

function fileFlags(
	diffBytes: number,
	changedLines: number,
	size: number | undefined,
): FileFlags {
	const flags: FileFlags = {}
	if (typeof size === 'number') flags.size = size
	if (isOversized(diffBytes, changedLines, size)) flags.oversized = true
	return flags
}

// Change class from the diff's paths alone (no contents): deleted (+++ /dev/null → no newPath),
// added (--- /dev/null → no oldPath), renamed (distinct paths), else modified.
function changeKindOf(
	oldPath: string | undefined,
	newPath: string | undefined,
): ReviewFile['changeKind'] {
	if (!newPath) return 'deleted'
	if (!oldPath) return 'added'
	return oldPath === newPath ? 'modified' : 'renamed'
}

// The file-level staleness key plus, for a working-tree new side, its byte size. A committed new
// side (pr's HEAD, staged's index) already has git's own OID from `git diff --raw`, so it needs no
// read; only a working-tree side is read, and only to hash it (the bytes aren't retained).
async function contentStamp(
	file: DiffFile,
	opts: DiffAssembly,
): Promise<{ contentHash: string; size: number | undefined }> {
	const committedOid = file.newPath
		? opts.newOids?.get(file.newPath)
		: undefined
	if (committedOid) return { contentHash: committedOid, size: undefined }
	// Working-tree new side (or a deletion, whose new side is /dev/null → fetchNew returns "").
	const newContents = await opts.fetchNew(file.newPath)
	return {
		contentHash: blobOid(newContents),
		size:
			opts.isWorkingSide && file.newPath
				? Buffer.byteLength(newContents, 'utf8')
				: undefined,
	}
}

// One parsed file → its ReviewFile: the parsed metadata, the staleness key, the counts and the
// rename/oversized stamps. No contents are retained (see contentStamp).
async function stampFile(
	file: DiffFile,
	opts: DiffAssembly,
): Promise<ReviewFile> {
	const { contentHash, size } = await contentStamp(file, opts)
	const { added, removed } = countHunkLines(file.hunks)
	const changeKind = changeKindOf(file.oldPath, file.newPath)
	return {
		...file, // oldPath/newPath carry the rename; the UI derives @pierre display names from them
		path: filePathOf(file),
		contentHash,
		changeKind,
		added,
		removed,
		// A zero-hunk entry with distinct paths is a pure rename: git -M at 100% similarity emits no
		// hunks, and parseUnifiedDiff only keeps such a zero-hunk section when it's a genuine rename.
		// A rename WITH edits carries hunks, so it isn't pure.
		renamePure: changeKind === 'renamed' && !file.hunks.length,
		...fileFlags(diffTextBytes(file.hunks), added + removed, size),
	}
}

// One stageable change block → its ChangeState. The title and the stableKey are what the UI groups
// by and what a Decision keys on, so both are derived here, once, per build.
function changeForBlock(input: {
	filePath: string
	hunk: DiffHunk
	hunkIndex: number
	block: readonly DiffLine[]
	isStageable: boolean
}): ChangeState {
	const firstAdd = input.block.find(line => line.kind === 'add')
	const firstDelete = input.block.find(line => line.kind === 'delete')
	const stableKey = changeStableKeyFromBlock(input.block)
	const removed = input.block.filter(line => line.kind === 'delete').length
	const added = input.block.filter(line => line.kind === 'add').length
	return {
		id: `${input.filePath}:${stableKey}`,
		path: input.filePath,
		hunkIndex: input.hunkIndex,
		side: firstAdd ? 'additions' : 'deletions',
		lineNumber:
			firstAdd?.newLine ?? firstDelete?.oldLine ?? input.hunk.newStart,
		stableKey,
		stageable: input.isStageable,
		contentHash: hash(changeBlockContent(input.block)),
		title: `${removed} removed · ${added} added`,
		status: 'pending',
	}
}

function changesForFile(file: DiffFile, isStageable: boolean): ChangeState[] {
	const filePath = filePathOf(file)
	return file.hunks.flatMap((hunk, hunkIndex) =>
		changeBlocks(hunk).map(block =>
			changeForBlock({ filePath, hunk, hunkIndex, block, isStageable }),
		),
	)
}

// The review files + change blocks one assembled diff produced, in diff order.
export type AssembledDiff = { files: ReviewFile[]; changes: ChangeState[] }

// Assemble review files + change blocks from an already-parsed unified diff, stamping lean metadata
// and tagging each change as stageable or not. Takes the parsed DiffFile[] (not rawDiff) so the one
// parse buildDiffSource did is reused rather than repeated (issue 06).
export async function assembleDiff(
	parsed: readonly DiffFile[],
	opts: DiffAssembly,
): Promise<AssembledDiff> {
	return {
		// One content read per working-tree file: bounded, since a monorepo diff can carry thousands
		// of files and each read holds a descriptor (see content-reads.ts).
		files: await mapContentReads(parsed, file => stampFile(file, opts)),
		changes: parsed.flatMap(file => changesForFile(file, opts.isStageable)),
	}
}

// A whole-file entry (file mode's tracked-unchanged / untracked-add; a repo untracked add). The new
// side is always the working copy, so its byte size is free from the bytes we already hold. Carries
// no contents - the tab fetches them on open (readFileContents).
export function fileEntry(
	filePath: string,
	newContents: string,
	changeKind: 'added' | 'modified',
): ReviewFile {
	// Only a fresh add carries a +count here (no hunk to sum); a tracked-unchanged full file is 0/0.
	const added = changeKind === 'added' ? lineCount(newContents) : 0
	const removed = 0
	return {
		oldPath: filePath,
		newPath: filePath,
		hunks: [],
		path: filePath,
		contentHash: blobOid(newContents),
		changeKind,
		added,
		removed,
		renamePure: false,
		// Hunk-less full-file adds (the 107 MB generated-JSON class) have no diff bytes to sum, so the
		// changed-line count and byte size are what flag them.
		...fileFlags(
			0,
			added + removed,
			Buffer.byteLength(newContents, 'utf8'),
		),
	}
}
