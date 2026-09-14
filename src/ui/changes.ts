import { diffAcceptRejectHunk } from '@pierre/diffs'

import { changeStableKey, deriveChanges } from './change-derive'
import { cur } from './contents'
import { pickCurrentFile } from './current-file'
import { deriveFlowIndex } from './flow-index'
import { buildLineMap } from './linemap'
import { D, requireState, S } from './store'

import type {
	ChangeContent,
	ContextContent,
	FileDiffMetadata,
} from '@pierre/diffs'
import type { FlowIndex } from './flow-index'
import type { DecidedPosition } from './linemap'
import type { ChangeState, ReviewComment, ReviewState, Side } from './types'

// One-pass per-path index over the live state for BULK derivations (the tree, walkthrough,
// progress, nav seeks, completion gate) - anywhere that classifies every file per evaluation.
// The per-path predicates below stay the source of truth for one-off call sites; iterating
// files through them is O(files × changes) and froze big desks (see flow-index.ts). Build the
// index once per evaluation and never cache it across effects.
export function flowIndex(): FlowIndex {
	return deriveFlowIndex(S.state)
}

type ReviewFile = ReviewState['files'][number]
type ChangeStatus = ChangeState['status']

// The file the diff is currently showing, or null when there is nothing to show: before main.ts
// adopts the first fetch, and after a reload whose rebuilt review carries no files. A `preview` (an
// unchanged file the reviewer opened to read/comment on) takes precedence over the indexed file.
export function currentFileOrNull(): ReviewFile | null {
	return pickCurrentFile(S.state?.files, S.preview, S.fileIndex)
}
// Is there a file to act on? The file-scoped actions (approve, open in the editor) and the keys
// that reach them clear this before calling currentFile(), which throws by contract: the pre-init
// window (no review yet) and a review a reload emptied both have no current file. Desk-level
// surfaces (help, settings, Send, Reset) deliberately do not depend on it.
export function hasCurrentFile(): boolean {
	return !!currentFileOrNull()
}
// The current file for the render path and the reviewer operations that follow it. Enforces the
// precondition - there is always a file to act on by then - rather than returning a stand-in.
export function currentFile(): ReviewFile {
	const file = currentFileOrNull()
	if (!file) throw new Error('no current file to show')
	return file
}
// Split view only makes sense for a two-sided diff. A new file (no old side), a deleted file
// (no new side), or a view-only full file (old === new - including any preview) render
// single-column, so split is a no-op - used to render them unified and to disable the toggle.
export function currentSplittable(): boolean {
	const f = S.preview ?? S.state?.files[S.fileIndex]
	if (!f) return true
	// Two-sided-ness is a property of the contents, which now arrive via the per-file fetch
	// (contents.ts `cur`). Until they're loaded for the current file, default to splittable - the
	// render pass awaits the fetch before it reads this, so the meaningful call sites see real bytes.
	if (cur.path !== f.path) return true
	const o = cur.oldContents,
		n = cur.newContents
	return o !== '' && n !== '' && o !== n
}
// Changes/comments of the current file. Empty without a current file - no path can match an
// absent one - so the template-reachable callers need no guard.
export function currentChanges(): ChangeState[] {
	const path = currentFileOrNull()?.path
	return (S.state?.changes ?? []).filter(c => c.path === path)
}
export function currentComments(): ReviewComment[] {
	const path = currentFileOrNull()?.path
	return (S.state?.comments ?? []).filter(c => c.path === path)
}

// ── File-level review state: pending / approved / changes-requested ──────────
export type FileReviewState = 'pending' | 'approved' | 'changes-requested'

// A file has objections if the reviewer rejected a hunk in it OR left an open requested-change
// comment (open, by the user, not a question). Questions are answered live, so they don't count.
// Mirrors the server's computeApprovedFiles so the desk and the handoff agree.
export function fileObjections(path: string): boolean {
	const rejected = (S.state?.decisions ?? []).some(
		d => d.path === path && d.status === 'rejected',
	)
	const openChange = (S.state?.comments ?? []).some(
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
export function fileFinished(path: string): boolean {
	const { state } = S
	if (!state?.reviewedFiles.includes(path)) return false
	const h = state.reviewedFileHashes?.[path]
	const file = state.files.find(f => f.path === path)
	return !!h && !!file && h === file.contentHash
}

// The single source of truth for a changed file's badge/header/progress state.
export function fileReviewState(path: string): FileReviewState {
	if (!fileFinished(path)) return 'pending'
	return fileObjections(path) ? 'changes-requested' : 'approved'
}

export function ensureChangesFromFileDiff(diff = D.fileDiff): void {
	if (!diff) return
	const state = requireState()
	const { path } = currentFile()
	const previous = new Map(
		state.changes.filter(c => c.path === path).map(c => [c.id, c]),
	)
	const derived = deriveChanges(diff, path, state.decisions, previous)
	state.changes = state.changes.filter(c => c.path !== path).concat(derived)
}

export type ChangePosition = { hunkIndex: number; changeIndex: number }

export function findChangePosition(
	diff: FileDiffMetadata,
	stableKey: string,
): ChangePosition | null {
	for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
		const h = diff.hunks[hunkIndex]
		const changeIndex = findHunkChange(h.hunkContent, stableKey)
		if (changeIndex !== null) return { hunkIndex, changeIndex }
	}
	return null
}

// The index of the change block carrying `stableKey` in one hunk, or null.
function findHunkChange(
	content: (ContextContent | ChangeContent)[],
	stableKey: string,
): number | null {
	for (let index = 0; index < content.length; index++) {
		const part = content[index]
		if (part.type === 'change' && changeStableKey(part) === stableKey)
			return index
	}
	return null
}

// Resolutions renumber lines but preserve hunk count and per-hunk content-entry count
// 1:1 (a resolved change becomes a context entry at the same index), so the recorded
// (hunkIndex, changeIndex) addresses the block in raw AND replayed diffs alike. The
// stableKey lookup (which embeds a line number) only remains as a fallback for legacy
// persisted changes that predate changeIndex - and is only sound against the raw diff.
function changePosition(
	diff: FileDiffMetadata,
	change: ChangeState,
): ChangePosition | null {
	const { changeIndex, hunkIndex, stableKey } = change
	// Legacy persisted changes predate changeIndex; only their (line-number-bearing) stableKey
	// identity is left, and that is only sound against the raw diff.
	if (typeof changeIndex !== 'number') {
		if (!stableKey) return null
		return findChangePosition(diff, stableKey)
	}
	const part = diff.hunks[hunkIndex].hunkContent[changeIndex]
	if (part.type !== 'change') return null
	return { hunkIndex, changeIndex }
}

export function applyDecisionToDiff(
	diff: FileDiffMetadata,
	change: ChangeState,
	status: ChangeStatus,
): FileDiffMetadata {
	const pos = changePosition(diff, change)
	if (!pos) return diff
	try {
		return diffAcceptRejectHunk(diff, pos.hunkIndex, {
			type: status === 'accepted' ? 'accept' : 'reject',
			changeIndex: pos.changeIndex,
		})
	} catch {
		return diff
	}
}

// Replay every decided block onto the raw diff, and rebuild the raw↔display line map
// the rest of the render (annotations, cursor, selections) converts through.
export function replayDecisions(diff: FileDiffMetadata): FileDiffMetadata {
	const decided: DecidedPosition[] = []
	// Resolve every position against the RAW diff up front (the fallback lookup would
	// mis-match against a partially resolved one), then apply by invariant indexes.
	for (const change of currentChanges().filter(c => c.status !== 'pending')) {
		const pos = changePosition(diff, change)
		if (pos)
			decided.push({
				...pos,
				status: change.status === 'rejected' ? 'rejected' : 'accepted',
			})
	}
	decided.sort(
		(a, b) => a.hunkIndex - b.hunkIndex || a.changeIndex - b.changeIndex,
	)
	D.lineMap = decided.length ? buildLineMap(diff, decided) : null
	let resolved = diff
	for (const d of decided) {
		try {
			resolved = diffAcceptRejectHunk(resolved, d.hunkIndex, {
				type: d.status === 'accepted' ? 'accept' : 'reject',
				changeIndex: d.changeIndex,
			})
		} catch {
			// leave this block unresolved rather than aborting the replay
		}
	}
	return resolved
}

// Refresh pending changes' display anchors from the replayed diff: the annotation for a
// block must sit at the line number @pierre will actually render, not the raw file line.
export function syncDisplayAnchors(resolved: FileDiffMetadata): void {
	for (const c of currentChanges()) {
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

// Raw ↔ display conversions for the current file (identity until decisions replay).
export function toDisplayLine(side: Side, line: number): number {
	return D.lineMap ? D.lineMap.toDisplay(side, line) : line
}
export function fromDisplayLine(side: Side, line: number): number {
	return D.lineMap ? D.lineMap.fromDisplay(side, line) : line
}
