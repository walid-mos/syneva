import { currentFile, fileObjections, flowIndex } from './changes'
import { nextUnreviewedFileIndex, guideProgress } from './guide'
import { render, deferRender } from './render'
import { api, persist, requireState, S, toast } from './store'

import type { ReviewFile } from '../types'
import type { ChangeState, Decision } from './types'

// The explicit decision record is the source of truth for accept/reject (decoupled
// from git staging). Every status change must go through these so it survives reload.
function recordDecision(change: ChangeState, status: Decision['status']): void {
	const state = requireState()
	state.decisions = state.decisions ?? []
	const key = `${change.path}:${change.stableKey}`
	const entry: Decision = {
		key,
		status,
		reviewedHash: change.contentHash,
		path: change.path,
		lineNumber: change.lineNumber,
		side: change.side,
		title: change.title,
	}
	const i = state.decisions.findIndex(d => d.key === key)
	if (i >= 0) state.decisions[i] = entry
	else state.decisions.push(entry)
}

function clearDecisions(path: string): void {
	const state = requireState()
	state.decisions = (state.decisions ?? []).filter(d => d.path !== path)
}

function acceptPendingChanges(path: string): void {
	const state = requireState()
	for (const change of state.changes) {
		if (change.path !== path || change.status !== 'pending') continue
		change.status = 'accepted'
		change.reviewedHash = change.contentHash
		recordDecision(change, 'accepted')
	}
}

function markFileReviewed(path: string, contentHash: string): void {
	const state = requireState()
	state.decisionFiles = state.decisionFiles ?? []
	if (!state.decisionFiles.includes(path)) state.decisionFiles.push(path)
	if (!state.reviewedFiles.includes(path)) state.reviewedFiles.push(path)
	state.reviewedFileHashes = state.reviewedFileHashes ?? {}
	state.reviewedFileHashes[path] = contentHash
}

// A working-mode move pair (issue 02) stages BOTH paths - `git add`-ing the old (deleted) path
// records the deletion, so the index ends with a rename. Only in working-repo mode: pr approve
// is a pure verdict, and staged mode can't contain these pairs. stagedFiles records the new path.
async function stageApprovedFile(
	file: ReviewFile,
	path: string,
): Promise<void> {
	const state = requireState()
	const moved = file.oldPath && file.newPath && file.oldPath !== file.newPath
	const pairMove = moved && state.mode === 'repo' && !state.staged
	const body = pairMove ? { paths: [file.oldPath, path] } : { path }
	await api('/api/stage', { method: 'POST', body: JSON.stringify(body) })
	if (!state.stagedFiles.includes(path)) state.stagedFiles.push(path)
}

// Sign off on the current file: accept any still-pending hunks (un-objected lines you've
// reviewed and didn't reject), mark the file finished against its current content hash, stage
// it when it's a clean approval and the "Approve stages file" setting is on, then advance.
// The displayed terminal state (approved vs changes-requested) is derived from objections.
export async function approveCurrentFile(): Promise<void> {
	const file = currentFile()
	const { path } = file
	const state = requireState()
	acceptPendingChanges(path)
	markFileReviewed(path, file.contentHash)
	// A file with objections (a rejected hunk or open requested-change comment) is "changes
	// requested" - the agent still has work on it, so never stage it. Clean → stage if enabled.
	const isClean = !fileObjections(path)
	if (isClean && S.settings.stageOnAccept) await stageApprovedFile(file, path)
	persist()
	const label = isClean ? 'Approved' : 'Marked reviewed'
	// The review-complete gate is over in-flow files only (issue 01/07): fully-skimmed files and
	// pure renames left the flow, so they never block completion (and are never auto-approved).
	// One flow-index pass instead of per-file predicate rescans (see flow-index.ts).
	const ix = flowIndex()
	const scope = state.files.filter(f => !ix.outOfFlow.has(f.path))
	// Every in-flow file signed off → the review is done: prompt to send it back to the agent.
	if (scope.every(f => state.reviewedFiles.includes(f.path))) {
		toast(`${label} - review complete`)
		void render()
		S.promptFinish?.()
		return
	}
	// Each sign-off toasts the running score ("7 of 12 files · 58%") so progress is felt at the
	// moment it moves, not just visible in the bar. % matches the strip (LOC-weighted by default).
	const done = scope.filter(f => ix.reviewState(f.path) !== 'pending').length
	toast(
		`${label} - ${done} of ${scope.length} files · ${guideProgress().pct}%`,
	)
	// Seek the next unreviewed file, wrapping past the end so a reviewer who jumped ahead is
	// carried back to the files they skipped instead of dead-ending here.
	const next = nextUnreviewedFileIndex(S.fileIndex)
	if (next !== null && S.selectFile) S.selectFile(next)
	else void render()
}

// Unstage is a git-index op the UI state already reflects - fire it without blocking so the
// re-render (and its indicator) start immediately, and swallow a failed index op.
async function unstagePath(path: string): Promise<void> {
	try {
		await api('/api/unstage', {
			method: 'POST',
			body: JSON.stringify({ path }),
		})
	} catch {
		// Best-effort: the reviewer-facing state is already reset above.
	}
}

// Undo a file's review: clear hunk decisions, the finished/sign-off marker + its hash, and unstage.
export async function resetReview(path: string): Promise<void> {
	const state = requireState()
	for (const change of state.changes)
		if (change.path === path) change.status = 'pending'
	clearDecisions(path)
	state.stagedChangeKeys = (state.stagedChangeKeys ?? []).filter(
		k => !k.startsWith(`${path}:`),
	)
	state.decisionFiles = (state.decisionFiles ?? []).filter(p => p !== path)
	state.reviewedFiles = state.reviewedFiles.filter(p => p !== path)
	const hashes = state.reviewedFileHashes ?? {}
	state.reviewedFileHashes = Object.fromEntries(
		Object.entries(hashes).filter(([hashedPath]) => hashedPath !== path),
	)
	state.stagedFiles = state.stagedFiles.filter(p => p !== path)
	// Reset restores hunks the approval had collapsed, which re-tokenizes a big file - show the
	// "Rendering…" indicator during it (deferRender(true) shows it for any big file).
	await unstagePath(path)
	deferRender(true)
	toast('Reset review')
	persist()
}

// Reject a whole file in one action, for the oversized-file card (issue 05): its blocks aren't
// visible there, so the honest equivalent of per-block reject is to reject every change block
// through the SAME decisions path. They flow into result.rejected like any rejected hunk - no new
// verdict kind, no new result semantics. Only meaningful when the file has change blocks (a
// hunk-less added file has none - the card hides the action there).
export async function rejectFile(path: string): Promise<void> {
	const state = requireState()
	const blocks = state.changes.filter(c => c.path === path)
	if (!blocks.length) return
	for (const change of blocks) {
		change.status = 'rejected'
		change.reviewedHash = change.contentHash
		recordDecision(change, 'rejected')
	}
	state.decisionFiles = state.decisionFiles ?? []
	if (!state.decisionFiles.includes(path)) state.decisionFiles.push(path)
	toast('Rejected file')
	void render()
	persist()
}

// Per-hunk accept/reject is now a pure verdict - staging happens only when the file is approved
// (so a changes-requested file is never left partially staged).
export async function acceptChange(
	id: string,
	status: Decision['status'],
): Promise<void> {
	const state = requireState()
	const change = state.changes.find(c => c.id === id)
	if (!change || change.status === status) return
	change.status = status
	change.reviewedHash = change.contentHash
	recordDecision(change, status)
	state.decisionFiles = state.decisionFiles ?? []
	if (!state.decisionFiles.includes(change.path))
		state.decisionFiles.push(change.path)
	// No need to apply the decision to D.fileDiff here: renderCenter unconditionally rebuilds
	// D.fileDiff from the raw diff (parse → ensureChanges → replayDecisions) every render, so a
	// pre-render mutation is thrown away - the replay below picks the new status up from the record.
	toast(status === 'rejected' ? 'Rejected' : 'Accepted')
	void render()
	persist()
}
