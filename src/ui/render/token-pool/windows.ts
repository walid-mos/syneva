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
// The stream lookahead is two windows wide: one band plus a window of read-ahead in each
// direction feels continuous on a wheel scroll, while the plan stays paused past it.
const STREAM_LOOKAHEAD_WINDOWS = 2
// Adjacent hunks closer than this merge into one cluster window (matches jsdiff's own context
// gap: anything closer was already merged into one hunk at parse time).
export const CLUSTER_GAP = 3
// Dense-rewrite guard: a hunk cluster owning at least this share of the file's slots makes
// per-hunk windows collapse toward n=1. Fixed-height windows over just that cluster are the
// fallback; rows outside the dense span stay plain (pathological rewrites, documented tradeoff).
export const DENSE_SLOT_SHARE = 0.4

// How far past the reviewer's viewport the background stream may run, in slots. Beyond it a
// window stays queued until a scroll brings it in range: eagerly tokenizing the whole file made
// the five workers chew ~29 s of shiki work for a dense 8000-line rewrite (measured, both sides
// counted) to colour rows the reviewer had not reached, and a fast switch to another file then
// found a fully booked pool. noteViewport re-drains on band changes, so the stream follows the
// reviewer instead of pre-paying for rows they may never read.
export const STREAM_LOOKAHEAD_SLOTS = STREAM_LOOKAHEAD_WINDOWS * WINDOW_SLOTS

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

// The renderer's own view window (the range it asks plain rows for), in slot space. It is the
// only trustworthy statement of what the reviewer can actually see: scroll position, expansion
// state and row heights are already folded into it by @pierre.
export type WindowViewport = { startingLine: number; totalLines: number }

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

// LPT order over the whole plan.
export function planByCost(
	diff: FileDiffMetadata,
	windows: WindowSpec[],
): WindowSpec[] {
	return windows
		.map(window => ({ window, units: estimateUnits(diff, window) }))
		.toSorted((a, b) => b.units - a.units)
		.map(entry => entry.window)
}

// Context lines count once; change-run pairs count by the longer side (the worker renders
// them pairwise).
function segmentCost(segment: ContextContent | ChangeContent): number {
	if (segment.type === 'change')
		return Math.max(segment.additions, segment.deletions)
	return segment.lines
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

// Just the visible band as its own window, or undefined when there is nothing to see (no
// viewport recorded yet, or an empty file). Deliberately NOT deduplicated against the rest of
// the plan: a band rarely aligns with WINDOW_SLOTS, and re-tokenizing the rows it overlaps costs
// one window, while replanning every surrounding window around the cut costs the whole plan's
// simplicity.
function viewportBand(
	diff: FileDiffMetadata,
	viewport: WindowViewport | undefined,
): WindowSpec | undefined {
	if (!viewport) return undefined
	const from = clamp(viewport.startingLine, 0, diff.splitLineCount)
	const to = clamp(
		viewport.startingLine + viewport.totalLines,
		from,
		diff.splitLineCount,
	)
	if (to <= from) return undefined
	return bandFrom(diff, from, to - from)
}

function bandFrom(
	diff: FileDiffMetadata,
	startingLine: number,
	totalLines: number,
): WindowSpec {
	return {
		kind: 'sweep',
		startingLine,
		totalLines,
		firstHunk: hunkBoundaryAt(diff, startingLine, '<='),
		lastHunk: hunkBoundaryAt(diff, startingLine + totalLines, '<'),
	}
}

// The visible band cut into `chunks` near-equal windows. One band window leaves the other pool
// workers chewing the rest of the file while the reviewer waits for the rows on screen; splitting
// it puts every worker on the visible rows first, so the reviewer's first colored paint is one
// chunk's tokenization instead of the whole band's. The workers' one-time grammar warm-up is then
// paid in parallel and reused by the background plan that follows.
function viewportBands(
	diff: FileDiffMetadata,
	viewport: WindowViewport | undefined,
	chunks: number,
): WindowSpec[] {
	const band = viewportBand(diff, viewport)
	if (!band) return []
	const count = Math.max(1, Math.min(chunks, band.totalLines))
	const size = Math.ceil(band.totalLines / count)
	const end = band.startingLine + band.totalLines
	const bands: WindowSpec[] = []
	for (let start = band.startingLine; start < end; start += size)
		bands.push(bandFrom(diff, start, Math.min(size, end - start)))
	return bands
}

// Dispatch order for one job: color what the reviewer is looking at first, then stream the rest
// of the file in cost order. Without the band the plan is LPT-ordered, so the first rows to
// color are whatever finishes first - typically a small tail window, off screen.
export function planWindowOrder(
	diff: FileDiffMetadata,
	viewport: WindowViewport | undefined,
	bandChunks = 1,
): WindowSpec[] {
	const plan = planByCost(diff, planTokenWindows(diff))
	return [...viewportBands(diff, viewport, bandChunks), ...plan]
}

function clamp(lineCount: number, low: number, high: number): number {
	return Math.min(Math.max(lineCount, low), high)
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
		// A slot no hunk reaches tokenizes nothing: the plain grid already paints those rows, and the
		// window would cost a dispatch plus an empty reply (measured 26 of 149 windows on the 16k-line
		// fixture). The hunks themselves stay covered by their own cluster windows, so nothing is lost.
		if (!spansHunk(diff, from, to)) continue
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

// Geometric overlap, not the hunk-boundary pair: a hunk starting before the slot can still end
// before it too, so `firstHunk`/`lastHunk` alone cannot tell whether a slot holds any row.
function spansHunk(diff: FileDiffMetadata, from: number, to: number): boolean {
	return diff.hunks.some(
		hunk =>
			hunk.splitLineStart < to &&
			hunk.splitLineStart + hunk.splitLineCount > from,
	)
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
