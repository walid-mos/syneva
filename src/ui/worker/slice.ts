// Structural slices for token windows: clone the covered hunks of a parsed diff, clip/keep
// their content segments to the window's slot range, and collect the per-side content indexes
// the shared emission emits. Pure metadata arithmetic - no jsdiff and no re-parse; the
// returned slice is a structural view the token render iterates exactly like @pierre's own
// non-windowed "both"-style pass.
import type {
	ChangeContent,
	ContextContent,
	FileDiffMetadata,
} from '@pierre/diffs'
import type { WindowSpec } from '../render/token-pool/windows'

export type WindowPositions = { deletion: number[]; addition: number[] }

// Clone the covered hunks and walk the segments they emit to collect per-side content indexes
// in emission order. Partials never expand regions (isPartial branch in getExpandedRegion): a
// collapsed gap emits NOTHING, stays plain until some window covers it, and both the slice
// render and this walk see the same emission set (context groups advance both sides 1:1;
// change groups emit deletion then addition content indexes ascending).
// Whole hunks (cluster windows, fully covered sweeps) keep their "\ No newline" markers;
// clipped hunks lose them - the window owning the hunk's real tail emits them instead.
export function buildSlice(
	diff: FileDiffMetadata,
	window: WindowSpec,
): { slice: FileDiffMetadata; positions: WindowPositions } {
	const covered = diff.hunks.slice(window.firstHunk, window.lastHunk + 1)
	if (!covered.length)
		throw new Error(
			`token-window: window @${window.startingLine} covers no hunk`,
		)
	const positions: WindowPositions = {
		deletion: [],
		addition: [],
	}
	const hunks = covered.map(hunk => sliceHunk(hunk, window, positions))
	return { slice: { ...diff, isPartial: true, hunks }, positions }
}

function sliceHunk(
	hunk: FileDiffMetadata['hunks'][number],
	window: WindowSpec,
	positions: WindowPositions,
): FileDiffMetadata['hunks'][number] {
	const withinFrom = Math.max(window.startingLine - hunk.splitLineStart, 0)
	const withinTo = Math.min(
		window.startingLine + window.totalLines - hunk.splitLineStart,
		hunk.splitLineCount,
	)
	const whole =
		window.kind === 'cluster' ||
		(withinFrom <= 0 && withinTo >= hunk.splitLineCount)
	const covered = whole
		? hunk.hunkContent
		: clipContent(hunk.hunkContent, withinFrom, withinTo)
	collectPositions(covered, positions)
	return {
		...hunk,
		noEOFCRAdditions: whole && hunk.noEOFCRAdditions,
		noEOFCRDeletions: whole && hunk.noEOFCRDeletions,
		hunkContent: covered,
	}
}

// Per-side content-index runs, ascending per group: context pairs fill the same slot; change
// groups list their deletions then their additions.
function collectPositions(
	content: (ContextContent | ChangeContent)[],
	into: WindowPositions,
): void {
	for (const segment of content) {
		if (segment.type === 'context') {
			pushRun(into.addition, segment.additionLineIndex, segment.lines)
			pushRun(into.deletion, segment.deletionLineIndex, segment.lines)
			continue
		}
		pushRun(into.deletion, segment.deletionLineIndex, segment.deletions)
		pushRun(into.addition, segment.additionLineIndex, segment.additions)
	}
}

function pushRun(into: number[], start: number, count: number): void {
	for (let step = 0; step < count; step++) into.push(start + step)
}

// Clip a hunk's content segments to its own [withinFrom, withinTo) slot range. Context groups
// slice exactly (advanced both sides 1:1); change groups stay atomic (a run straddling the edge
// tokenizes whole rather than splitting a word-diff pair across windows).
export function clipContent(
	content: (ContextContent | ChangeContent)[],
	from: number,
	to: number,
): (ContextContent | ChangeContent)[] {
	const clipped: (ContextContent | ChangeContent)[] = []
	let slot = 0
	for (const segment of content) {
		const segmentSlots =
			segment.type === 'change'
				? Math.max(segment.additions, segment.deletions)
				: segment.lines
		const overlapFrom = Math.max(slot, from)
		const overlapTo = Math.min(slot + segmentSlots, to)
		if (overlapFrom >= overlapTo) {
			slot += segmentSlots
			continue
		}
		if (segment.type === 'change') clipped.push(segment)
		else
			clipped.push(
				clipContext(
					segment,
					overlapFrom - slot,
					overlapTo - overlapFrom,
				),
			)
		slot += segmentSlots
	}
	return clipped
}

function clipContext(
	segment: ContextContent,
	skip: number,
	lines: number,
): ContextContent {
	return {
		type: 'context',
		lines,
		additionLineIndex: segment.additionLineIndex + skip,
		deletionLineIndex: segment.deletionLineIndex + skip,
	}
}
