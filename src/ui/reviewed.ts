import { flowIndex } from './changes'
import { render } from './render'
import { persistPrefs, S, toast } from './store'
import { CARET_CLOSED, CARET_OPEN } from './tree-structure'

import type { FileRow, TreeRow } from './types'

// ── Distill reviewed material (the multi-round lens) ────────────────────────
// settings.hideReviewed reshapes round 2/3 reviews: accepted change bands drop out of the
// rendered diff (render/distill.ts) and fully-approved files fold out of the tree and
// walkthrough into a collapsed "Reviewed" group (the Skimmed-group pattern, flow-index).
// Display only: decisions, comments, progress and the review-complete gate are untouched.
// The pref is persisted (~/.galley/settings.json) so the lens survives tab/round/OS, and
// every surface reads it off the same flag at render time - nothing is cached session-side.

// True when the review carries at least one accepted block: the only state the toggle can
// reshape. The header hides it on pristine reviews (nothing to distill yet).
export function hasReviewedMaterial(): boolean {
	return (S.state?.decisions ?? []).some(d => d.status === 'accepted')
}

// Flip the pref, persist it, and repaint: the diff key bans on the pref, so the next render
// rebuilds the metadata with (or without) the distilled bands.
export function toggleHideReviewed(): void {
	S.settings = { ...S.settings, hideReviewed: !S.settings.hideReviewed }
	void persistPrefs()
	void render()
	toast(
		S.settings.hideReviewed
			? 'Hide accepted changes on'
			: 'Hide accepted changes off',
	)
}

// Per-session expand state for the collapsed "Reviewed" group, keyed beside the skim
// group's sentinel in S.skimExpanded. Not persisted: only folding is display-only.
const REVIEWED_GROUP_KEY = 'group:reviewed'

export function isReviewedGroupExpanded(): boolean {
	return S.skimExpanded.has(REVIEWED_GROUP_KEY)
}

export function toggleReviewedGroup(): void {
	if (S.skimExpanded.has(REVIEWED_GROUP_KEY))
		S.skimExpanded.delete(REVIEWED_GROUP_KEY)
	else S.skimExpanded.add(REVIEWED_GROUP_KEY)
	// Tree/walkthrough rows re-derive reactively; the render refreshes the Overview page.
	void render()
}

// The fully-approved (signed off, no objections) files that only unfold when the pref is on.
// flowIndex computes the set; this is the single re-derivation point for group counts.
export function reviewedPaths(): string[] {
	if (!S.settings.hideReviewed || !S.state) return []
	const ix = flowIndex()
	return [...ix.distilled]
}

// ── The "Reviewed" tree group ──────────────────────────────────────────────────
// Lives beside the Skimmed group's tree builder: same collapsed flat-group pattern
// (the test-fold precedent), different label. Its rows stay the plain file rows with the
// APPROVED badge - that's why they were folded, not because they're unworthy of a badge.

// A distilled (fully approved) file's row inside the Reviewed group: keeps its approved
// badge; clicking opens it like any other file.
function approvedFileRow(path: string, fileIndex: number | undefined): FileRow {
	return {
		key: `file:${path}`,
		kind: 'file',
		depth: 1,
		name: path.split('/').pop() ?? path,
		cls: '',
		style: '--depth:1',
		path,
		fileIndex,
		testToggle: false,
		testKey: '',
		testCaret: CARET_CLOSED,
		changeType: null,
		state: 'approved',
		skim: false,
		movedFrom: '',
	}
}

// The hide-reviewed lens' trailing tree group: files signed off clean, folded out of the
// main listing while the pref is on. Expand state is per-session (isReviewedGroupExpanded).
export function pushReviewedGroup(
	rows: TreeRow[],
	reviewed: string[],
	fileIndexOf: (path: string) => number | undefined,
): void {
	if (!reviewed.length) return
	const isOpen = isReviewedGroupExpanded()
	rows.push({
		kind: 'skimgrp',
		key: 'group:reviewed',
		count: reviewed.length,
		open: isOpen,
		caret: isOpen ? CARET_OPEN : CARET_CLOSED,
		group: 'reviewed',
	})
	if (!isOpen) return
	const ordered = [...reviewed]
	ordered.sort((a, b) => a.localeCompare(b))
	for (const path of ordered)
		rows.push(approvedFileRow(path, fileIndexOf(path)))
}
