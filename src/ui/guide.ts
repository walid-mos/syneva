import { flowIndex } from './changes'
import { isGuideBaseStale } from './guide-derive'
import { renderMarkdown } from './markdown'
import { isReviewedGroupExpanded } from './reviewed'
import {
	navFileOrder,
	nextUnreviewed,
	wrapNextTarget,
	wrapPrevTarget,
} from './seek'
import { isSkimGroupExpanded } from './skim'
import { $, esc, requireState, S } from './store'
import { lineStats, walkthroughGroups, walkRows } from './walkthrough'

import type { FlowIndex } from './flow-index'
import type { GuideFile } from './types'
import type { WalkGroup, WalkRow } from './walkthrough'

// Whether the current review carries an agent-attached guide with at least one file.
export function hasGuide(): boolean {
	return !!S.state?.guide?.files.length
}

// state.files indices in the guide's order (skip guide entries whose file isn't in the diff).
export function guideOrder(): number[] {
	const { state } = S
	if (!state?.guide?.files.length) return []
	const byPath = new Map(state.files.map((f, i) => [f.path, i] as const))
	return state.guide.files
		.map(g => byPath.get(g.path))
		.filter((i): i is number => typeof i === 'number')
}

// Where "Start guided review" lands - the first in-flow file in nav order (fully-skimmed files
// are excluded from navOrder), else, when every file is skimmed, the first file so Start still
// opens something.
export function firstGuideIndex(): number {
	const nav = navOrder()
	if (nav.length) return nav[0]
	const order = guideOrder()
	return order.length ? order[0] : 0
}

// Plain next/prev stepping skips fully-skimmed files - they've left the flow - UNLESS the
// reviewer is currently on one (opened from the Skimmed group), in which case stepping walks the
// skimmed band so the group's siblings stay reachable. `outOfBand(i)` is true for a file in the
// opposite band from `cur`. Off either band's end returns null and the caller wraps (guideNext/
// guidePrev), where the wrap seeks (navOrder) only ever target the in-flow band.
function outOfBand(cur: number): (i: number) => boolean {
	// The returned predicate runs per candidate file while stepping - one flow-index pass here
	// instead of a per-candidate rescan (see flow-index.ts).
	const { outOfFlow } = flowIndex()
	const path = S.state?.files.at(cur)?.path
	const curSkimmed = !!path && outOfFlow.has(path)
	return i => {
		const p = S.state?.files.at(i)?.path
		return (!!p && outOfFlow.has(p)) !== curSkimmed
	}
}

// The band's candidates after `cur` (direction 1) or before it (-1), nearest-first - the guide
// order when `cur` is listed in it, else the file array.
function stepCandidates(cur: number, direction: 1 | -1): number[] {
	const order = hasGuide() ? guideOrder() : []
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
	const count = S.state?.files.length ?? 0
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
export function nextFileIndex(cur: number): number | null {
	return firstInBand(stepCandidates(cur, 1), outOfBand(cur))
}

// The previous in-band file before `cur` (guide order, else sequential). null at the first -
// the caller treats that as "go back to the Overview page".
export function prevFileIndex(cur: number): number | null {
	return firstInBand(stepCandidates(cur, -1), outOfBand(cur))
}

// The order file navigation walks and wraps around. Without a guide it's the file array; with
// one it's the guide order followed by every changed file the guide DIDN'T list (the
// walkthrough's "Other" group), in file-array order - so the seek reaches unlisted files and
// never dead-ends on a partial guide. Fully-skimmed files are excluded (issue 07): this is the
// single choke point that keeps the wrap/approve-advance seeks off files that left the flow.
// Plain mid-list stepping (nextFileIndex) reads its own band order, not this; only the seek/wrap
// helpers read this extended order.
// The seeks below classify every file per call, so each public entry builds ONE flow-index
// pass and threads it through (per-file predicate rescans froze big desks - see flow-index.ts).
function navOrderWith(ix: FlowIndex): number[] {
	const count = S.state?.files.length ?? 0
	return navFileOrder(count, hasGuide() ? guideOrder() : null, i => {
		const p = S.state?.files.at(i)?.path
		return !!p && !ix.outOfFlow.has(p)
	})
}
export function navOrder(): number[] {
	return navOrderWith(flowIndex())
}

// "Unreviewed" for the seek - a file not signed off in the current state, matching the tree
// badges and floating approve button (an agent edit after sign-off invalidates the hash, so
// the file counts as unreviewed again). Index-reading equivalent of fileFinished.
function seekFinishedWith(ix: FlowIndex): (i: number) => boolean {
	return i => {
		const path = S.state?.files.at(i)?.path
		return !!path && ix.finished(path)
	}
}

// Is there any unreviewed file left anywhere in the nav order?
export function anyUnreviewed(): boolean {
	const ix = flowIndex()
	return navOrderWith(ix).some(i => !seekFinishedWith(ix)(i))
}

// The next unreviewed file after `cur`, wrapping past the end - approve-advance's seek.
// null when no unreviewed file remains (the caller falls back to the review-complete prompt).
export function nextUnreviewedFileIndex(cur: number): number | null {
	const ix = flowIndex()
	return nextUnreviewed(navOrderWith(ix), cur, seekFinishedWith(ix))
}

// Where plain "next" lands when it steps off the last file: first unreviewed, else first file.
export function nextWrapIndex(): number | null {
	const ix = flowIndex()
	return wrapNextTarget(navOrderWith(ix), seekFinishedWith(ix))
}

// Where plain "prev" lands when it steps off the first position: last unreviewed, else last file.
export function prevWrapIndex(): number | null {
	const ix = flowIndex()
	return wrapPrevTarget(navOrderWith(ix), seekFinishedWith(ix))
}

// Changed lines (additions + deletions) per file path - the weight used for progress, so
// finishing a big file advances the bar more than a tiny one. Min 1 so every file counts.
function locByPath(): Map<string, number> {
	const m = new Map<string, number>()
	for (const [path, s] of lineStats(S.state?.files ?? []))
		m.set(path, Math.max(s.added + s.removed, 1))
	return m
}

// Guide categories + their files (plus the trailing "Other" group of unlisted diff files) -
// the data behind the Walkthrough sidebar tab and the Overview file list. The hide-reviewed
// lens folds fully-approved files into a trailing "Reviewed" group alongside it.
export function walkGroups(): WalkGroup[] {
	const { state } = S
	if (!state?.guide?.files.length) return []
	// One flow-index pass backs both predicates for the whole group derivation. The distilled
	// predicate reads the pref itself: empty set when off.
	const ix = flowIndex()
	return walkthroughGroups(
		state.guide.files,
		state.files,
		p => ix.reviewState(p),
		{ skim: p => ix.outOfFlow.has(p), distilled: p => ix.distilled.has(p) },
	)
}

// Flat rows for the Walkthrough tab's x-for. The "active" highlight is deliberately NOT derived
// here (activePath = null): reading S.fileIndex/S.preview/S.overviewOpen made every file switch
// re-run this whole x-for. applyActiveRow (tree.ts) patches the class imperatively for both
// sidebars. The trailing "Skimmed"/"Reviewed" groups' file rows appear only while expanded.
export function walkthroughRows(): WalkRow[] {
	return walkRows(walkGroups(), null, {
		skim: isSkimGroupExpanded(),
		reviewed: isReviewedGroupExpanded(),
	})
}

// Overall review progress for the guide-bar indicator, weighted by changed lines (LOC) rather
// than file count: "done" sums the LOC of files the reviewer finished (approved OR
// changes-requested), "approved" the clean-signoff LOC.
export function guideProgress(): {
	done: number
	approved: number
	total: number
	pct: number
} {
	const PERCENT_SCALE = 100
	const isByLines = S.settings.progressBy !== 'files'
	const linesPerFile = isByLines ? locByPath() : null
	// One flow-index pass for the whole loop (see flow-index.ts).
	const ix = flowIndex()
	let total = 0,
		done = 0,
		approved = 0
	for (const f of S.state?.files ?? []) {
		// Fully-skimmed files carry no progress weight - they left the flow (issue 07). The
		// hide-reviewed lens folds approved files out the same way: they're already 'done',
		// so shedding them from both done and total leaves the percentage unchanged.
		if (ix.outOfFlow.has(f.path) || ix.distilled.has(f.path)) continue
		// LOC-weighted progress counts a file's changed lines; file-weighted counts it as 1.
		const weight = linesPerFile ? (linesPerFile.get(f.path) ?? 1) : 1
		total += weight
		const st = ix.reviewState(f.path)
		if (st !== 'pending') done += weight
		if (st === 'approved') approved += weight
	}
	// total === 0 means every changed file is fully skimmed (a desk always has ≥1 file, and the
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
export function currentGuideEntry(): GuideFile | null {
	const { state } = S
	if (!state?.guide) return null
	const f = state.files.at(S.fileIndex)
	if (!f) return null
	return state.guide.files.find(g => g.path === f.path) ?? null
}

export function currentFileName(): string {
	return S.state?.files.at(S.fileIndex)?.path.split('/').pop() ?? ''
}

// Show the top guide bar whenever a guide is attached - including on the Overview page
// (where the overview is treated as the position before the first file).
export function showGuideBar(): boolean {
	return hasGuide()
}

// The guide was generated against an older diff than the one now loaded (e.g. the agent
// edited code and the desk reloaded). Advisory only - the guide still renders.
export function guideStale(): boolean {
	const { state } = S
	if (!state?.guide) return false
	return isGuideBaseStale(state.baseDiffHash, state.guide.baseDiffHash)
}

// Render the Overview page into #diff: overview → optional PR description → Start. No file
// list - the sidebar (tree/walkthrough, including the Skimmed group) already lists every file,
// so repeating them here was redundant; per-file orientation renders in each file's header.
// Called by render() when overviewOpen && hasGuide().
export function renderOverview(): void {
	const state = requireState()
	const g = state.guide
	if (!g) return
	// '' counts as absent: a guide without a title still names the desk's target ref.
	const title = [g.title, state.target].find(Boolean) ?? 'Review'
	$('diff').innerHTML = `<div class="guide-overview"><div class="go-card">
    <h1>${esc(title)}</h1>
    <div class="go-sub">${esc(state.mode)} · ${esc(state.session)} · ${state.files.length} files</div>
    ${g.focused ? `<div class="go-focused"><svg class="ic"><use href="#gly-collapse-all"></use></svg> Focused review - mechanical churn skimmed</div>` : ''}
    ${guideStale() ? `<div class="go-stale"><svg class="ic"><use href="#gly-warn"></use></svg> This guide was generated for an earlier version of the diff. Regenerate it and restart the desk with <code>--guide</code> to refresh.</div>` : ''}
    <div class="go-overview md">${renderMarkdown(g.overview)}</div>
    ${g.prDescription ? `<div class="go-pr"><b>PR description</b><div class="md">${renderMarkdown(g.prDescription)}</div></div>` : ''}
    <div class="go-actions"><button class="btn primary" id="guideStart">Start Review <kbd>↵</kbd></button></div>
  </div></div>`
	const start = $('diff').querySelector<HTMLButtonElement>('#guideStart')
	// The Overview markup is rebuilt on every render, so this cannot stack listeners.
	start?.addEventListener('click', () => S.startGuided?.())
}
