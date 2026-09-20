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

type Rebase = Pick<
	FileDiffMetadata['hunks'][number],
	| 'additionLineIndex'
	| 'deletionLineIndex'
	| 'unifiedLineStart'
	| 'splitLineStart'
	| 'additionStart'
	| 'deletionStart'
>

// Clone the covered hunks and walk their segments once, collecting per-side content indexes in
// emission order. The walk derives every index itself - hunk-level starts advanced by per-segment
// line counts, the same arithmetic @pierre's own iteration runs - because the parsed segments'
// *LineIndex fields cannot be trusted: the pinned parser does not maintain them per side
// (measured: a late context segment carries deletionLineIndex == additionLineIndex, ~1000 rows
// off once the sides drift). Scattering the worker's rows at renderer-derived indexes is what
// makes them land where the renderer looks them up.
//
// Partials never expand regions (isPartial branch in getExpandedRegion): a collapsed gap emits
// NOTHING, stays plain until some window covers it, and both the slice render and this walk see
// the same emission set (context groups advance both sides 1:1; change groups emit deletion then
// addition content indexes ascending).
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
	const covered: (ContextContent | ChangeContent)[] = []
	const walk = new HunkWalk(hunk, window, positions, covered)
	const rebased = walk.run()
	return {
		...hunk,
		...rebased,
		// Whole hunks keep their "\ No newline" markers; clipped ones lose them - the window
		// owning the hunk's real tail emits them instead.
		noEOFCRAdditions: walk.whole && hunk.noEOFCRAdditions,
		noEOFCRDeletions: walk.whole && hunk.noEOFCRDeletions,
		hunkContent: covered,
	}
}

// The walk's running counters: the renderer's own per-side indexes, advanced segment by segment.
class HunkWalk {
	#hunk: FileDiffMetadata['hunks'][number]
	#positions: WindowPositions
	#covered: (ContextContent | ChangeContent)[]
	whole: boolean
	#withinFrom: number
	#withinTo: number
	#slot = 0
	#addition: number
	#deletion: number
	#unified: number
	#additionStart: number
	#deletionStart: number
	#rebased: Rebase | undefined

	constructor(
		hunk: FileDiffMetadata['hunks'][number],
		window: WindowSpec,
		positions: WindowPositions,
		covered: (ContextContent | ChangeContent)[],
	) {
		this.#hunk = hunk
		this.#positions = positions
		this.#covered = covered
		const withinFrom = Math.max(
			window.startingLine - hunk.splitLineStart,
			0,
		)
		const withinTo = Math.min(
			window.startingLine + window.totalLines - hunk.splitLineStart,
			hunk.splitLineCount,
		)
		this.#withinFrom = withinFrom
		this.#withinTo = withinTo
		this.whole =
			window.kind === 'cluster' ||
			(withinFrom <= 0 && withinTo >= hunk.splitLineCount)
		this.#addition = hunk.additionLineIndex
		this.#deletion = hunk.deletionLineIndex
		this.#unified = hunk.unifiedLineStart
		this.#additionStart = hunk.additionStart
		this.#deletionStart = hunk.deletionStart
	}

	run(): Rebase | undefined {
		for (const segment of this.#hunk.hunkContent) {
			this.#step(segment)
			if (!this.whole && this.#slot >= this.#withinTo) break
		}
		return this.#rebased
	}

	#step(segment: ContextContent | ChangeContent): void {
		const segmentSlots = segmentSlotsOf(segment)
		const keepFrom = this.whole ? 0 : Math.max(this.#slot, this.#withinFrom)
		const keepTo = this.whole
			? segmentSlots
			: Math.min(this.#slot + segmentSlots, this.#withinTo)
		if (keepFrom < keepTo) {
			this.#rebased ??= this.#rebasedStarts(keepFrom)
			this.#keep(segment, keepFrom - this.#slot, keepTo - keepFrom)
		}
		this.#slot += segmentSlots
		this.#addition = advance(this.#addition, segment, 'addition')
		this.#deletion = advance(this.#deletion, segment, 'deletion')
		this.#unified = advance(this.#unified, segment, 'unified')
		this.#additionStart = advance(this.#additionStart, segment, 'addition')
		this.#deletionStart = advance(this.#deletionStart, segment, 'deletion')
	}

	#rebasedStarts(keepFrom: number): Rebase {
		const skip = keepFrom - this.#slot
		return {
			additionLineIndex: this.#addition + skip,
			deletionLineIndex: this.#deletion + skip,
			unifiedLineStart: this.#unified + skip,
			splitLineStart: this.#hunk.splitLineStart + keepFrom,
			additionStart: this.#additionStart + skip,
			deletionStart: this.#deletionStart + skip,
		}
	}

	// Change groups stay atomic (a run straddling the edge tokenizes whole rather than splitting
	// a word-diff pair across windows), so their rows go out whole; context groups clip exactly.
	#keep(
		segment: ContextContent | ChangeContent,
		skip: number,
		lines: number,
	): void {
		if (segment.type === 'change') {
			this.#covered.push(segment)
			pushRun(this.#positions.deletion, this.#deletion, segment.deletions)
			pushRun(this.#positions.addition, this.#addition, segment.additions)
			return
		}
		this.#covered.push({
			type: 'context',
			lines,
			additionLineIndex: this.#addition + skip,
			deletionLineIndex: this.#deletion + skip,
		})
		pushRun(this.#positions.addition, this.#addition + skip, lines)
		pushRun(this.#positions.deletion, this.#deletion + skip, lines)
	}
}

type Segment = ContextContent | ChangeContent

function segmentSlotsOf(segment: Segment): number {
	return segment.type === 'change'
		? Math.max(segment.additions, segment.deletions)
		: segment.lines
}

function advance(
	count: number,
	segment: Segment,
	side: 'addition' | 'deletion' | 'unified',
): number {
	if (segment.type !== 'change') return count + segment.lines
	if (side === 'unified') return count + segment.deletions + segment.additions
	return side === 'addition'
		? count + segment.additions
		: count + segment.deletions
}

function pushRun(into: number[], start: number, count: number): void {
	for (let step = 0; step < count; step++) into.push(start + step)
}
