// Window planning for the token pool: the split of one file's tokenization into independent
// worker tasks (@pierre tokenizes the whole diff as ONE task - 1.9-2.0 ms per line-unit of file
// content, so a 16k-line sparse file pays ~53 s in a single task regardless of how few lines
// changed). Slots are @pierre's iteration rows: hunk.splitLineStart/count position a hunk inside
// diff.splitLineCount, and the worker recovers each emitted row's per-side content index by
// replaying the same iteration over a structural slice of the planned hunks (see
// diff-token-worker.ts). Hybrid policy exists because jsdiff's default 3-line context merges
// dense rewrites into ONE hunk spanning the whole file: per-hunk windows degenerate to n=1 there
// (zero gain exactly where it hurts), so dense files get fixed-height windows clipped to the
// dense span, while sparse files get one cluster window per hunk span plus a fixed-window sweep
// over the untouched context - so every row eventually tokenizes; until a window lands, the
// merged skeleton shows its plain rows.
import type {
	ChangeContent,
	ContextContent,
	FileDiffMetadata,
} from '@pierre/diffs'

// Target work per window, in slot rows. 192±4 was the Lab-B sweet spot: small enough for
// progressive arrival, large enough that the ~35-45 ms per-task fixed overhead stays negligible.
export const WINDOW_SLOTS = 192
// Adjacent hunks closer than this merge into one cluster window (matches jsdiff's own context
// gap: anything closer was already merged into one hunk at parse time).
export const CLUSTER_GAP = 3
// Dense-rewrite guard: a hunk cluster owning at least this share of the file's slots makes
// per-hunk windows collapse toward n=1. Fixed-height windows over just that cluster are the
// fallback; rows outside the dense span stay plain (pathological rewrites, documented tradeoff).
export const DENSE_SLOT_SHARE = 0.4

// Cluster windows slice whole hunks (no clipping; the slice may emit a few rows beyond the
// nominal bounds - strictly more highlighted rows). Sweep windows clip hunk segments to their
// slot range - what keeps dense single-hunk files from re-tokenizing the whole file per window.
export type WindowKind = 'cluster' | 'sweep'
export type WindowSpec = {
	kind: WindowKind
	startingLine: number
	totalLines: number
	firstHunk: number
	lastHunk: number
}

// Approximated worker cost for one window: per-side line-units of the slots it touches (context
// counts; change-run pairs count once). Order-of-magnitude equal to @pierre's real
// ~2 ms/line-unit - good enough to schedule long jobs first.
export function estimateUnits(
	diff: FileDiffMetadata,
	window: WindowSpec,
): number {
	let units = 0
	for (const hunk of diff.hunks.slice(window.firstHunk, window.lastHunk + 1))
		units += hunk.hunkContent.reduce(
			(sum, segment) => sum + segmentCost(segment),
			0,
		)
	return units
}

// Context lines count once; change-run pairs count by the longer side (the worker renders
// them pairwise).
function segmentCost(segment: ContextContent | ChangeContent): number {
	if (segment.type === 'change')
		return Math.max(segment.additions, segment.deletions)
	return segment.lines
}

// Longest-processing-time batch order: windows sorted longest-first so a scheduler that hands
// jobs to the least busy worker finishes the plan fastest.
export function planByCost(
	diff: FileDiffMetadata,
	windows: WindowSpec[],
): WindowSpec[] {
	return windows
		.map(window => ({ window, units: estimateUnits(diff, window) }))
		.toSorted((a, b) => b.units - a.units)
		.map(entry => entry.window)
}

type SlotSpan = { from: number; to: number }

// Hunk spans in slot space, adjacent ones merged when closer than CLUSTER_GAP.
export function hunkClusters(diff: FileDiffMetadata): SlotSpan[] {
	const clusters: SlotSpan[] = []
	for (const hunk of diff.hunks) {
		const from = hunk.splitLineStart
		const to = from + hunk.splitLineCount
		const last = clusters.at(-1)
		if (last && from - last.to <= CLUSTER_GAP) last.to = to
		else clusters.push({ from, to })
	}
	return clusters
}

export function planTokenWindows(diff: FileDiffMetadata): WindowSpec[] {
	const clusters = hunkClusters(diff)
	const dense = clusters.find(
		cluster =>
			cluster.to - cluster.from >= diff.splitLineCount * DENSE_SLOT_SHARE,
	)
	if (dense) return denseWindows(diff, dense)
	return [
		...clusterWindows(diff, clusters),
		...sweepWindows(diff, diff.splitLineCount),
	]
}

// Sparse path: one whole-hunk-cluster window per hunk span, then a fixed-window sweep over the
// whole file (clip jobs; the result cache collapses the overlap with cluster windows).
function clusterWindows(
	diff: FileDiffMetadata,
	clusters: SlotSpan[],
): WindowSpec[] {
	return clusters.map(
		(cluster, clusterIndex) =>
			({
				kind: 'cluster',
				startingLine: cluster.from,
				totalLines: cluster.to - cluster.from,
				firstHunk: clusterIndex,
				lastHunk: lastHunkInSpan(diff, clusterIndex, cluster.to),
			}) satisfies WindowSpec,
	)
}

// A later hunk starting inside the (merged) cluster span rides along in the same whole-hunk
// slice; straddling hunks whose rows poke past `to` simply add rows - harmless when the slice
// owns whole hunks.
function lastHunkInSpan(
	diff: FileDiffMetadata,
	fromIndex: number,
	to: number,
): number {
	const straddling = diff.hunks
		.slice(fromIndex + 1)
		.findIndex(hunk => hunk.splitLineStart < to)
	if (straddling === -1) return fromIndex
	return fromIndex + 1 + straddling
}

function sweepWindows(diff: FileDiffMetadata, total: number): WindowSpec[] {
	const windows: WindowSpec[] = []
	for (let from = 0; from < total; from += WINDOW_SLOTS) {
		const to = Math.min(total, from + WINDOW_SLOTS)
		windows.push({
			kind: 'sweep',
			startingLine: from,
			totalLines: to - from,
			firstHunk: hunkBoundaryAt(diff, from, '<='),
			lastHunk: hunkBoundaryAt(diff, to, '<'),
		})
	}
	return windows
}

// Dense path: fixed-height windows clipped to the dense cluster's own span.
function denseWindows(diff: FileDiffMetadata, dense: SlotSpan): WindowSpec[] {
	const windows: WindowSpec[] = []
	for (
		let from = dense.from - (dense.from % WINDOW_SLOTS);
		from < dense.to;
		from = Math.max(from + WINDOW_SLOTS, from + 1)
	) {
		const to = Math.min(dense.to, from + WINDOW_SLOTS)
		windows.push({
			kind: 'sweep',
			startingLine: from,
			totalLines: to - from,
			firstHunk: hunkBoundaryAt(diff, from, '<='),
			lastHunk: hunkBoundaryAt(diff, to, '<'),
		})
	}
	// Subtracting the alignment keeps window count minimal while every window fits [0, total).
	return windows.filter(window => window.totalLines > 0)
}

function hunkBoundaryAt(
	diff: FileDiffMetadata,
	slot: number,
	kind: '<' | '<=',
): number {
	let index = 0
	diff.hunks.forEach((hunk, i) => {
		const start = hunk.splitLineStart
		if (kind === '<=' ? start <= slot : start < slot) index = i
	})
	return index
}
