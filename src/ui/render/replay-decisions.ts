import { diffAcceptRejectHunk } from '@pierre/diffs'

import { changeStableKey } from '../change-derive'
import { currentChanges } from '../changes'
import { buildLineMap } from '../linemap'
import { D } from '../store'

import type {
	ChangeContent,
	ContextContent,
	FileDiffMetadata,
} from '@pierre/diffs'
import type { DecidedPosition } from '../linemap'
import type { ChangeState } from '../types'

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
