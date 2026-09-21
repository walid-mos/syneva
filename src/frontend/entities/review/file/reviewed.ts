import { deriveFlowIndex } from '../change/flow-index'

import { CARET_CLOSED, CARET_OPEN } from './tree-structure'

import type { ReviewState } from '../model'
import type { FileRow, TreeRow } from './tree-rows'

// ── Distill reviewed material (the multi-round lens) ────────────────────────
// settings.hideReviewed reshapes round 2/3 reviews: accepted change bands drop out of the
// rendered diff (shared/diff-renderer/distill.ts) and fully-approved files fold out of the
// tree and walkthrough into a collapsed "Reviewed" group (the Renamed-group pattern, flow-index).
// Display only: decisions, comments, progress and the review-complete gate are untouched.
// The pref is persisted (~/.syneva/settings.json) so the lens survives tab/round/OS, and
// every surface reads it off the same flag at render time - nothing is cached session-side.
// The pref's persistence/toast/repaint orchestration is app-owned (see the header bindings).

// True when the review carries at least one accepted block: the only state the toggle can
// reshape. The header hides it on pristine reviews (nothing to distill yet).
export function hasReviewedMaterial(state: ReviewState | null): boolean {
	return (state?.decisions ?? []).some(d => d.status === 'accepted')
}

// Per-session expand state for the collapsed "Reviewed" group, keyed beside the Renamed
// group's sentinel in the session fold set. Not persisted: only folding is display-only.
// The toggle mutates the set the caller owns; rows re-derive reactively and the caller repaints.
const REVIEWED_GROUP_KEY = 'group:reviewed'

export function isReviewedGroupExpanded(foldExpanded: Set<string>): boolean {
	return foldExpanded.has(REVIEWED_GROUP_KEY)
}

export function toggleReviewedGroup(foldExpanded: Set<string>): void {
	if (foldExpanded.has(REVIEWED_GROUP_KEY))
		foldExpanded.delete(REVIEWED_GROUP_KEY)
	else foldExpanded.add(REVIEWED_GROUP_KEY)
}

// The fully-approved (signed off, no objections) files that only unfold when the pref is on.
// flowIndex computes the set; this is the single re-derivation point for group counts.
export function reviewedPaths(
	state: ReviewState | null,
	shouldHideReviewed: boolean,
): string[] {
	if (!shouldHideReviewed || !state) return []
	return [
		...deriveFlowIndex(state, { distill: shouldHideReviewed }).distilled,
	]
}

// ── The "Reviewed" tree group ──────────────────────────────────────────────
// Lives beside the Renamed group's tree builder: same collapsed flat-group pattern
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
		movedFrom: '',
	}
}

// The hide-reviewed lens' trailing tree group: files signed off clean, folded out of the
// main listing while the pref is on. Expand state is per-session (isReviewedGroupExpanded).
export function pushReviewedGroup(
	rows: TreeRow[],
	reviewed: string[],
	isOpen: boolean,
	fileIndexOf: (path: string) => number | undefined,
): void {
	if (!reviewed.length) return
	rows.push({
		kind: 'foldgrp',
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
