import { deriveChanges } from './change/change-derive'
import { deriveFlowIndex } from './change/flow-index'
import { pickCurrentFile } from './current-file'
import { cur } from './file/contents'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { LineMap } from '@shared/diff-renderer/linemap'
import type { Side } from '@shared/diff-renderer/types'
import type { FlowIndex } from './change/flow-index'
import type {
	ChangeState,
	FileReviewState,
	PreviewFile,
	ReviewComment,
	ReviewFile,
	ReviewState,
} from './model'

// One-pass per-path index over the live state for BULK derivations (the tree, walkthrough,
// progress, nav seeks, completion gate) - anywhere that classifies every file per evaluation.
// The per-path predicates below stay the source of truth for one-off call sites; iterating
// files through them is O(files × changes) and froze big desks (see flow-index.ts). Build the
// index once per evaluation and never cache it across effects. The distill option rides the
// hide-reviewed preference so every index evaluation depends on the toggle reactively.
export function flowIndex(
	state: ReviewState | null,
	opts: { distill: boolean },
): FlowIndex {
	return deriveFlowIndex(state, { distill: opts.distill })
}

// The file the diff is currently showing, or null when there is nothing to show: before main.ts
// adopts the first fetch, and after a reload whose rebuilt review carries no files. A `preview` (an
// unchanged file the reviewer opened to read/comment on) takes precedence over the indexed file.
export function currentFileOrNull(
	files: ReviewFile[] | undefined,
	preview: PreviewFile | null,
	fileIndex: number,
): ReviewFile | null {
	return pickCurrentFile(files, preview, fileIndex)
}

// Is there a file to act on? The file-scoped actions (approve, open in the editor) and the keys
// that reach them clear this before calling currentFile(), which throws by contract: the pre-init
// window (no review yet) and a review a reload emptied both have no current file. Desk-level
// surfaces (help, settings, Send, Reset) deliberately do not depend on it.
export function hasCurrentFile(
	files: ReviewFile[] | undefined,
	preview: PreviewFile | null,
	fileIndex: number,
): boolean {
	return !!currentFileOrNull(files, preview, fileIndex)
}

// The current file for the render path and the reviewer operations that follow it. Enforces the
// precondition - there is always a file to act on by then - rather than returning a stand-in.
export function currentFile(
	files: ReviewFile[] | undefined,
	preview: PreviewFile | null,
	fileIndex: number,
): ReviewFile {
	const file = currentFileOrNull(files, preview, fileIndex)
	if (!file) throw new Error('no current file to show')
	return file
}

// Changes/comments of a file. Empty without a file - no path can match an absent one - so the
// template-reachable callers need no guard.
export function currentChanges(
	state: ReviewState | null,
	file: ReviewFile | null,
): ChangeState[] {
	const path = file?.path
	return (state?.changes ?? []).filter(c => c.path === path)
}
export function currentComments(
	state: ReviewState | null,
	file: ReviewFile | null,
): ReviewComment[] {
	const path = file?.path
	return (state?.comments ?? []).filter(c => c.path === path)
}

// ── Whole-file comments ────────────────────────────────────────────────────
// lineNumber 0 is the whole-file anchor (real lines are 1-based, so it can never collide with
// a rendered one); the persisted record stamps anchor "file" alongside it. Sister copy of
// FILE_LEVEL_LINE in state/comments.ts - the UI must not import backend runtime code.
const FILE_LEVEL_LINE = 0

// Is this comment addressed to the file as a whole (a file-header thread) rather than a diff line?
// Takes a structural subset so non-comment shapes carrying the same anchor (e.g. jump targets)
// classify the same way.
export function isFileComment(c: Pick<ReviewComment, 'lineNumber'>): boolean {
	return c.lineNumber === FILE_LEVEL_LINE
}

function sideLineCount(file: ReviewFile, side: ReviewComment['side']): number {
	// Line counts come from the current file's fetched contents (file/contents.ts `cur`); this runs
	// during render() for the current file, so cur is loaded. If it isn't the current file yet,
	// return Infinity so the out-of-range fallback can't wrongly flag a thread as unanchored (the
	// authoritative `unanchored` flag from server-side re-anchoring is still honored by the caller).
	if (cur.path !== file.path) return Infinity
	const contents = side === 'deletions' ? cur.oldContents : cur.newContents
	if (!contents) return 0
	return contents.split('\n').length
}

// Re-anchoring (reanchorComments, server-side on reload) sets `unanchored` explicitly;
// the out-of-range check additionally catches legacy comments it couldn't classify. One
// derivation for every consumer (the diff island's thread strip and the auto-expand pass) -
// both must agree on which open threads are unreachable in the rendered diff.
export function isUnanchored(c: ReviewComment, file: ReviewFile): boolean {
	return c.unanchored === true || c.lineNumber > sideLineCount(file, c.side)
}

// The file's whole-file comments, oldest first.
export function currentFileComments(
	state: ReviewState | null,
	file: ReviewFile | null,
): ReviewComment[] {
	return currentComments(state, file)
		.filter(isFileComment)
		.toSorted((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
}

// A file has objections if the reviewer rejected a hunk in it OR left an open requested-change
// comment (open, by the user, not a question). Questions are answered live, so they don't count.
// Mirrors the server's computeApprovedFiles so the desk and the handoff agree.
export function fileObjections(
	state: ReviewState | null,
	path: string,
): boolean {
	const rejected = (state?.decisions ?? []).some(
		d => d.path === path && d.status === 'rejected',
	)
	const openChange = (state?.comments ?? []).some(
		c =>
			c.path === path &&
			c.status === 'open' &&
			c.role !== 'agent' &&
			c.intent !== 'question',
	)
	return rejected || openChange
}

// A file is "finished" only while its sign-off is current: it's in reviewedFiles and the content
// hash recorded at sign-off still matches the file (the agent hasn't rewritten it since).
export function fileFinished(state: ReviewState | null, path: string): boolean {
	if (!state?.reviewedFiles.includes(path)) return false
	const h = state.reviewedFileHashes?.[path]
	const file = state.files.find(f => f.path === path)
	return !!h && !!file && h === file.contentHash
}

// The single source of truth for a changed file's badge/header/progress state.
export function fileReviewState(
	state: ReviewState | null,
	path: string,
): FileReviewState {
	if (!fileFinished(state, path)) return 'pending'
	return fileObjections(state, path) ? 'changes-requested' : 'approved'
}

export function ensureChangesFromFileDiff(
	diff: FileDiffMetadata | null | undefined,
	state: ReviewState,
	file: ReviewFile,
): void {
	if (!diff) return
	const { path } = file
	const previous = new Map(
		state.changes.filter(c => c.path === path).map(c => [c.id, c]),
	)
	const derived = deriveChanges(diff, path, state.decisions, previous)
	// The caller's live reactive store is this function's mutation target by
	// contract - the assignment IS the API, not a side effect on a borrowed parameter.
	// oxlint-disable-next-line eslint/no-param-reassign
	state.changes = state.changes.filter(c => c.path !== path).concat(derived)
}

// Refresh pending changes' display anchors from the replayed diff: the annotation for a
// block must sit at the line number @pierre will actually render, not the raw file line.
export function syncDisplayAnchors(
	resolved: FileDiffMetadata,
	changes: ChangeState[],
): void {
	for (const c of changes) {
		if (c.status !== 'pending') continue
		if (typeof c.changeIndex !== 'number') continue
		const part = resolved.hunks[c.hunkIndex].hunkContent[c.changeIndex]
		if (part.type !== 'change') continue
		const lineNumber =
			(c.side === 'additions'
				? part.additionLineIndex
				: part.deletionLineIndex) + 1
		c.displayLineNumber = lineNumber
		c.displayEndLine =
			c.side === 'additions'
				? part.additionLineIndex + (part.additions || 1)
				: part.deletionLineIndex + (part.deletions || 1)
	}
}

// Raw ↔ display conversions (identity until decisions replay): the caller passes the
// widget-owned line map of the current render.
export function toDisplayLine(
	side: Side,
	line: number,
	lineMap: LineMap | null,
): number {
	return lineMap ? lineMap.toDisplay(side, line) : line
}
export function fromDisplayLine(
	side: Side,
	line: number,
	lineMap: LineMap | null,
): number {
	return lineMap ? lineMap.fromDisplay(side, line) : line
}
