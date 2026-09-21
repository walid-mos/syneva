import type { ChangeContent, FileDiffMetadata } from '@pierre/diffs'
import type { Side } from '@shared/diff-renderer/types'
import type { ChangeState, Decision } from '../model'

// Client-side change derivation: turn a parsed @pierre diff into the ChangeState records the rest
// of the UI works in (annotations, cursor, decisions, staging). Identity is the stableKey, so a
// block keeps its record - and its decision - across re-derivations of the same content.

export function changeStableKey(part: ChangeContent): string {
	const side = part.additions > 0 ? 'additions' : 'deletions'
	const lineNumber =
		(side === 'additions'
			? part.additionLineIndex
			: part.deletionLineIndex) + 1
	return `${side}:${lineNumber}:${part.deletions || 0}:${part.additions || 0}`
}

// Where a change block sits in the diff: its side (the side that gained lines decides), the
// 1-based display line it starts at, and the line it ends at. A block whose other side is empty
// still spans one line, hence the `|| 1` on the count.
function changeSpan(part: ChangeContent): {
	side: Side
	lineNumber: number
	endLine: number
} {
	if (part.additions > 0)
		return {
			side: 'additions',
			lineNumber: part.additionLineIndex + 1,
			endLine: part.additionLineIndex + (part.additions || 1),
		}
	return {
		side: 'deletions',
		lineNumber: part.deletionLineIndex + 1,
		endLine: part.deletionLineIndex + (part.deletions || 1),
	}
}

// One derived ChangeState, carrying the identity-preserving fields forward from the block's
// previous record (same id → same block).
function deriveChange(
	block: { part: ChangeContent; hunkIndex: number; contentIndex: number },
	context: {
		path: string
		decisions: Decision[]
		previous: Map<string, ChangeState>
	},
): ChangeState {
	const { path, decisions, previous } = context
	const { part, hunkIndex, contentIndex } = block
	const stableKey = changeStableKey(part)
	const id = `${path}:${stableKey}`
	const prev = previous.get(id)
	// Status comes from the explicit decision record (source of truth), not from whether the
	// hunk happens to be staged.
	const decision = decisions.find(d => d.key === id)
	const status: ChangeState['status'] = decision?.status ?? 'pending'
	return {
		id,
		path,
		hunkIndex,
		changeIndex: contentIndex,
		stableKey,
		...changeSpan(part),
		title: `${part.deletions} removed · ${part.additions} added`,
		status,
		stageable: prev?.stageable,
		contentHash: prev?.contentHash,
		reviewedHash: decision?.reviewedHash ?? prev?.reviewedHash,
	}
}

// The change records of one parsed diff. `decisions` is the live decision list (the source of
// truth for a block's status); `previous` carries stage/review metadata forward to blocks whose
// identity survives the re-derivation.
export function deriveChanges(
	diff: FileDiffMetadata,
	path: string,
	decisions: Decision[] = [],
	previous = new Map<string, ChangeState>(),
): ChangeState[] {
	const context = { path, decisions, previous }
	const derived: ChangeState[] = []
	for (const [hunkIndex, hunk] of diff.hunks.entries())
		derived.push(...deriveHunkChanges(hunk, hunkIndex, context))
	return derived
}

// The derived changes of one hunk, in content order.
function deriveHunkChanges(
	hunk: FileDiffMetadata['hunks'][number],
	hunkIndex: number,
	context: {
		path: string
		decisions: Decision[]
		previous: Map<string, ChangeState>
	},
): ChangeState[] {
	const derived: ChangeState[] = []
	for (const [contentIndex, part] of hunk.hunkContent.entries()) {
		if (part.type === 'change')
			derived.push(
				deriveChange({ part, hunkIndex, contentIndex }, context),
			)
	}
	return derived
}
