import { flowIndex } from '../changes'
import { isRenamedGroupExpanded } from '../file/renames'
import { isReviewedGroupExpanded } from '../file/reviewed'

import { isGuideBaseStale } from './guide-derive'
import {
	navFileOrder,
	wrapNextTarget,
	wrapPrevTarget,
} from './seek'
import { lineStats, walkthroughGroups, walkRows } from './walkthrough'

import type { FlowIndex } from '../change/flow-index'
import type { GuideFile, ReviewState } from '../model'
import type { WalkGroup, WalkRow } from './walkthrough'

// Everything one guide derivation reads, supplied explicitly by the caller (the app
// facade builds it from the reactive store). The distill/progress preferences ride in so
// every derivation depends on them reactively.
export type GuideInputs = {
	state: ReviewState | null
	fileIndex: number
	hideReviewed: boolean
	progressBy: 'lines' | 'files'
	foldExpanded: Set<string>
}

// Whether the current review carries an agent-attached guide with at least one file.
export function hasGuide(g: GuideInputs): boolean {
	return !!g.state?.guide?.files.length
}

// state.files indices in the guide's order (skip guide entries whose file isn't in the diff).
export function guideOrder(g: GuideInputs): number[] {
	const { state } = g
	if (!state?.guide?.files.length) return []
	const byPath = new Map(state.files.map((f, i) => [f.path, i] as const))
	return state.guide.files
		.map(entry => byPath.get(entry.path))
		.filter((i): i is number => typeof i === 'number')
}

// Where "Start Review" lands - the first in-flow file in nav order (files out of the flow are
// excluded from navOrder), else, when every file is out of the flow, the first file so Start still
// opens something.
export function firstGuideIndex(g: GuideInputs): number {
	const nav = navOrder(g)
	if (nav.length) return nav[0]
	const order = guideOrder(g)
	return order.length ? order[0] : 0
}

// Plain next/prev stepping skips files out of the flow (pure renames) - they've left the
// listing - UNLESS the reviewer is currently on one (opened from the Renamed group), in which
// case stepping walks that band so the group's siblings stay reachable. `outOfBand(i)` is true
// for a file in the opposite band from `cur`. Off either band's end returns null and the caller
// wraps (guideNext/guidePrev), where the wrap seeks (navOrder) only ever target the in-flow band.
function outOfBand(
	g: GuideInputs,
	ix: FlowIndex,
	cur: number,
): (i: number) => boolean {
	// The returned predicate runs per candidate file while stepping - one flow-index pass here
	// instead of a per-candidate rescan (see flow-index.ts).
	const { outOfFlow } = ix
	const path = g.state?.files.at(cur)?.path
	const curOutOfFlow = !!path && outOfFlow.has(path)
	return i => {
		const p = g.state?.files.at(i)?.path
		return (!!p && outOfFlow.has(p)) !== curOutOfFlow
	}
}

// The band's candidates after `cur` (direction 1) or before it (-1), nearest-first - the guide
// order when `cur` is listed in it, else the file array.
function stepCandidates(
	g: GuideInputs,
	cur: number,
	direction: 1 | -1,
): number[] {
	const order = hasGuide(g) ? guideOrder(g) : []
	const pos = order.indexOf(cur)
	if (pos >= 0) {
		const candidates: number[] = []
		for (
			let p = pos + direction;
			p >= 0 && p < order.length;
			p += direction
		)
			candidates.push(order[p])
		return candidates
	}
	const count = g.state?.files.length ?? 0
	const candidates: number[] = []
	for (let i = cur + direction; i >= 0 && i < count; i += direction)
		candidates.push(i)
	return candidates
}

// The first candidate still inside the band `cur` belongs to.
function firstInBand(
	candidates: number[],
	skip: (i: number) => boolean,
): number | null {
	for (const i of candidates) if (!skip(i)) return i
	return null
}

// The next file to review after `cur`: the next in-band file in guide order when a guide is
// attached (and `cur` is in it), else the next in-band file sequentially. null when `cur` is the
// last of its band.
export function nextFileIndex(g: GuideInputs, cur: number): number | null {
	return firstInBand(
		stepCandidates(g, cur, 1),
		outOfBand(g, flowIndexOf(g), cur),
	)
}

// The previous in-band file before `cur` (guide order, else sequential). null at the first -
// the caller treats that as "go back to the Overview page".
export function prevFileIndex(g: GuideInputs, cur: number): number | null {
	return firstInBand(
		stepCandidates(g, cur, -1),
		outOfBand(g, flowIndexOf(g), cur),
	)
}

// The order file navigation walks and wraps around. Without a guide it's the file array; with
// one it's the guide order followed by every changed file the guide DIDN'T list (the
// walkthrough's "Other" group), in file-array order - so the seek reaches unlisted files and
// never dead-ends on a partial guide. Files out of the flow (pure renames) are excluded: this is
// the single choke point that keeps the wrap/approve-advance seeks off files with nothing to
// review. Plain mid-list stepping (nextFileIndex) reads its own band order, not this; only the
// seek/wrap helpers read this extended order.
// The seeks below classify every file per call, so each public entry builds ONE flow-index
// pass and threads it through (per-file predicate rescans froze big desks - see flow-index.ts).
function navOrderWith(g: GuideInputs, ix: FlowIndex): number[] {
	const count = g.state?.files.length ?? 0
	return navFileOrder(count, hasGuide(g) ? guideOrder(g) : null, i => {
		const p = g.state?.files.at(i)?.path
		return !!p && !ix.outOfFlow.has(p)
	})
}

// One flow-index pass per derivation, built from the explicit inputs (never cached across
// effects - Alpine's dependency tracking requires the fresh build).
function flowIndexOf(g: GuideInputs): FlowIndex {
	return flowIndex(g.state, { distill: g.hideReviewed })
}

export function navOrder(g: GuideInputs): number[] {
	return navOrderWith(g, flowIndexOf(g))
}

// "Unreviewed" for the seek - a file not signed off in the current state, matching the tree
// badges and floating approve button (an agent edit after sign-off invalidates the hash, so
// the file counts as unreviewed again). Index-reading equivalent of fileFinished.
function seekFinishedWith(
	g: GuideInputs,
	ix: FlowIndex,
): (i: number) => boolean {
	return i => {
		const path = g.state?.files.at(i)?.path
		return !!path && ix.finished(path)
	}
}

// Is there any unreviewed file left anywhere in the nav order?
export function anyUnreviewed(g: GuideInputs): boolean {
	const ix = flowIndexOf(g)
	return navOrderWith(g, ix).some(i => !seekFinishedWith(g, ix)(i))
}

// Where plain "next" lands when it steps off the last file: first unreviewed, else first file.
export function nextWrapIndex(g: GuideInputs): number | null {
	const ix = flowIndexOf(g)
	return wrapNextTarget(navOrderWith(g, ix), seekFinishedWith(g, ix))
}

// Where plain "prev" lands when it steps off the first position: last unreviewed, else last file.
export function prevWrapIndex(g: GuideInputs): number | null {
	const ix = flowIndexOf(g)
	return wrapPrevTarget(navOrderWith(g, ix), seekFinishedWith(g, ix))
}

// Changed lines (additions + deletions) per file path - the weight used for progress, so
// finishing a big file advances the bar more than a tiny one. Min 1 so every file counts.
function locByPath(state: ReviewState): Map<string, number> {
	const m = new Map<string, number>()
	for (const [path, s] of lineStats(state.files))
		m.set(path, Math.max(s.added + s.removed, 1))
	return m
}

// Guide categories + their files (plus the trailing "Other" group of unlisted diff files) -
// the data behind the Walkthrough sidebar tab. Two trailing fold groups ride along: pure
// renames, and - with the hide-reviewed lens on - fully-approved files.
export function walkGroups(g: GuideInputs): WalkGroup[] {
	const { state } = g
	if (!state?.guide?.files.length) return []
	// One flow-index pass backs both predicates for the whole group derivation. The distilled
	// predicate reads the pref itself: empty set when off.
	const ix = flowIndexOf(g)
	return walkthroughGroups(
		state.guide.files,
		state.files,
		p => ix.reviewState(p),
		{
			renamed: p => ix.outOfFlow.has(p),
			distilled: p => ix.distilled.has(p),
		},
	)
}

// Flat rows for the Walkthrough tab's x-for. The "active" highlight is deliberately NOT derived
// here (activePath = null): reading g.fileIndex/S.preview/S.overviewOpen made every file switch
// re-run this whole x-for. applyActiveRow (tree.ts) patches the class imperatively for both
// sidebars. The trailing "Renamed"/"Reviewed" groups' file rows appear only while expanded.
export function walkthroughRows(g: GuideInputs): WalkRow[] {
	// The row being viewed carries the active highlight: the walkthrough is one of the two
	// sortings, so "where am I" reads off it the same way the tree's active row does.
	const activePath =
		g.state && typeof g.fileIndex === 'number'
			? (g.state.files[g.fileIndex]?.path ?? null)
			: null
	return walkRows(walkGroups(g), activePath, {
		renamed: isRenamedGroupExpanded(g.foldExpanded),
		reviewed: isReviewedGroupExpanded(g.foldExpanded),
	})
}

// Overall review progress for the guide-bar indicator, weighted by changed lines (LOC) rather
// than file count: "done" sums the LOC of files the reviewer finished (approved OR
// changes-requested), "approved" the clean-signoff LOC.
export function guideProgress(g: GuideInputs): {
	done: number
	approved: number
	total: number
	pct: number
} {
	const PERCENT_SCALE = 100
	const isByLines = g.progressBy !== 'files'
	const linesPerFile = isByLines && g.state ? locByPath(g.state) : null
	// One flow-index pass for the whole loop (see flow-index.ts).
	const ix = flowIndexOf(g)
	let total = 0,
		done = 0,
		approved = 0
	for (const f of g.state?.files ?? []) {
		// Files out of the flow (pure renames) carry no progress weight - there is nothing in them
		// to review. The hide-reviewed lens folds approved files out the same way: they're already
		// 'done', so shedding them from both done and total leaves the percentage unchanged.
		if (ix.outOfFlow.has(f.path) || ix.distilled.has(f.path)) continue
		// LOC-weighted progress counts a file's changed lines; file-weighted counts it as 1.
		const weight = linesPerFile ? (linesPerFile.get(f.path) ?? 1) : 1
		total += weight
		const st = ix.reviewState(f.path)
		if (st !== 'pending') done += weight
		if (st === 'approved') approved += weight
	}
	// total === 0 means every changed file is out of the flow (a desk always has ≥1 file, and the
	// strip is hidden when there are none): nothing needs review, so the bar reads complete rather
	// than a misleading 0%.
	return {
		done,
		approved,
		total,
		pct: total ? Math.round((done / total) * PERCENT_SCALE) : PERCENT_SCALE,
	}
}

// The guide entry for the file currently shown (or null) - drives the top guide bar.
export function currentGuideEntry(g: GuideInputs): GuideFile | null {
	const { state } = g
	if (!state?.guide) return null
	const f = state.files.at(g.fileIndex)
	if (!f) return null
	return state.guide.files.find(entry => entry.path === f.path) ?? null
}

export function currentFileName(g: GuideInputs): string {
	return g.state?.files.at(g.fileIndex)?.path.split('/').pop() ?? ''
}

// Show the top guide bar whenever a guide is attached - including on the Overview page
// (where the overview is treated as the position before the first file).
export function showGuideBar(g: GuideInputs): boolean {
	return hasGuide(g)
}

// The guide was generated against an older diff than the one now loaded (e.g. the agent
// edited code and the desk reloaded). Advisory only - the guide still renders.
export function guideStale(g: GuideInputs): boolean {
	const { state } = g
	if (!state?.guide) return false
	return isGuideBaseStale(state.baseDiffHash, state.guide.baseDiffHash)
}

