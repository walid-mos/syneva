import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	CLUSTER_GAP,
	DENSE_SLOT_SHARE,
	WINDOW_SLOTS,
	estimateUnits,
	hunkClusters,
	planByCost,
	planTokenWindows,
	planWindowOrder,
} from '@shared/diff-renderer/token-pool/windows'

import type {
	ChangeContent,
	ContextContent,
	FileDiffMetadata,
	Hunk,
} from '@pierre/diffs'

// Handbuilt metadata fixtures (no parser dependency): the planner consumes only hunk slot
// spans and hunkContent segment sizes.
const ctx = (
	lines: number,
	additionLineIndex = 0,
	deletionLineIndex = 0,
): ContextContent => ({
	type: 'context',
	lines,
	additionLineIndex,
	deletionLineIndex,
})
const change = (additions: number, deletions: number): ChangeContent => ({
	type: 'change',
	additions,
	deletions,
	additionLineIndex: 0,
	deletionLineIndex: 0,
})
const hunk = (
	splitLineStart: number,
	splitLineCount: number,
	content: (ContextContent | ChangeContent)[] = [ctx(splitLineCount)],
): Hunk => ({
	collapsedBefore: 0,
	splitLineStart,
	splitLineCount,
	unifiedLineStart: splitLineStart,
	unifiedLineCount: splitLineCount,
	additionStart: 1,
	additionCount: splitLineCount,
	additionLines: 0,
	additionLineIndex: 0,
	deletionStart: 1,
	deletionCount: splitLineCount,
	deletionLines: 0,
	deletionLineIndex: 0,
	hunkContent: content,
	hunkSpecs: '@@',
	noEOFCRAdditions: false,
	noEOFCRDeletions: false,
})
const metadata = (hunks: Hunk[], splitLineCount: number): FileDiffMetadata => ({
	name: 'a.ts',
	type: 'rename-changed',
	hunks,
	splitLineCount,
	unifiedLineCount: splitLineCount,
	isPartial: false,
	additionLines: [],
	deletionLines: [],
	cacheKey: 'k',
})

void test('hunkClusters merges adjacent spans under the gap threshold and keeps distant ones apart', () => {
	const apart = metadata([hunk(0, 5), hunk(5 + CLUSTER_GAP + 1, 4)], 13)
	assert.deepEqual(hunkClusters(apart), [
		{ from: 0, to: 5 },
		{ from: 9, to: 13 },
	])
	const merged = metadata([hunk(0, 5), hunk(5 + CLUSTER_GAP, 4)], 12)
	assert.deepEqual(hunkClusters(merged), [{ from: 0, to: 12 }])
})

void test('sparse file: one cluster window per hunk span plus a full sweep, clusters first', () => {
	const diff = metadata([hunk(0, 7), hunk(14, 6)], 20)
	assert.deepEqual(planTokenWindows(diff), [
		{
			kind: 'cluster',
			startingLine: 0,
			totalLines: 7,
			firstHunk: 0,
			lastHunk: 0,
		},
		{
			kind: 'cluster',
			startingLine: 14,
			totalLines: 6,
			firstHunk: 1,
			lastHunk: 1,
		},
		{
			kind: 'sweep',
			startingLine: 0,
			totalLines: 20,
			firstHunk: 0,
			lastHunk: 1,
		},
	])
})

void test('cluster window extends its slice when the next hunk starts inside the cluster span', () => {
	// Total 60 keeps the merged 12-slot span under the dense share (24), forcing the sparse path.
	const diff = metadata([hunk(0, 8), hunk(8, 4)], 60)
	assert.deepEqual(planTokenWindows(diff), [
		{
			kind: 'cluster',
			startingLine: 0,
			totalLines: 12,
			firstHunk: 0,
			lastHunk: 1,
		},
		{
			kind: 'sweep',
			startingLine: 0,
			totalLines: 60,
			firstHunk: 0,
			lastHunk: 1,
		},
	])
})

void test('dense single-hunk file: fixed windows over the dense span only, no cluster windows', () => {
	const diff = metadata([hunk(0, 100, [ctx(10), change(1, 1)])], 100)
	assert.deepEqual(planTokenWindows(diff), [
		{
			kind: 'sweep',
			startingLine: 0,
			totalLines: 100,
			firstHunk: 0,
			lastHunk: 0,
		},
	])
})

void test('dense hunk beside far sparse context: windows only inside the dense span', () => {
	const denseTo = 50
	const diff = metadata(
		[
			hunk(0, denseTo),
			hunk(denseTo + WINDOW_SLOTS, 4, [ctx(1), change(1, 1)]),
		],
		100,
	)
	// The threshold must hold for this fixture, else the assertions prove nothing.
	assert.ok(denseTo >= 100 * DENSE_SLOT_SHARE)
	assert.deepEqual(planTokenWindows(diff), [
		{
			kind: 'sweep',
			startingLine: 0,
			totalLines: denseTo,
			firstHunk: 0,
			lastHunk: 0,
		},
	])
})

void test('dense path clips the last window at the dense span end', () => {
	const total = WINDOW_SLOTS + 5
	const diff = metadata([hunk(0, total)], total)
	assert.deepEqual(planTokenWindows(diff), [
		{
			kind: 'sweep',
			startingLine: 0,
			totalLines: WINDOW_SLOTS,
			firstHunk: 0,
			lastHunk: 0,
		},
		{
			kind: 'sweep',
			startingLine: WINDOW_SLOTS,
			totalLines: 5,
			firstHunk: 0,
			lastHunk: 0,
		},
	])
})

void test('sparse path sweeps only the slots that reach a hunk', () => {
	const total = WINDOW_SLOTS * 2 + 3
	const diff = metadata([hunk(0, 4), hunk(300, 4)], total)
	const plan = planTokenWindows(diff)
	// Sparse path: cluster windows first, then the sweep stepping WINDOW_SLOTS. The trailing slot
	// [WINDOW_SLOTS * 2, total) reaches no hunk (the second hunk ends at 304) and is dropped: it
	// would have tokenized nothing.
	assert.deepEqual(
		plan.map(window => [
			window.kind,
			window.startingLine,
			window.totalLines,
			window.lastHunk,
		]),
		[
			['cluster', 0, 4, 0],
			['cluster', 300, 4, 1],
			['sweep', 0, WINDOW_SLOTS, 0],
			['sweep', WINDOW_SLOTS, WINDOW_SLOTS, 1],
		],
	)
})

void test('planByCost orders windows longest-processing-task first', () => {
	const diff = metadata(
		[hunk(0, 4, [ctx(2), change(9, 3)]), hunk(10, 2, [ctx(1)])],
		14,
	)
	const ordered = planByCost(diff, planTokenWindows(diff))
	// Hand cost: sweep(2+9+1=12), cluster0(2+9=11), cluster1(1).
	assert.deepEqual(
		ordered.map(w => [w.kind, w.startingLine]),
		[
			['sweep', 0],
			['cluster', 0],
			['cluster', 10],
		],
	)
})

void test('planWindowOrder without a viewport is exactly the cost-ordered plan', () => {
	const diff = metadata([hunk(0, 7), hunk(14, 6)], 20)
	const actual: unknown = planWindowOrder(diff, undefined)
	assert.deepEqual(actual, planByCost(diff, planTokenWindows(diff)))
})

void test('planWindowOrder splits the band across the pool so every worker starts on screen', () => {
	const diff = metadata([hunk(0, 7), hunk(14, 6)], 20)
	const ordered = planWindowOrder(
		diff,
		{ startingLine: 0, totalLines: 17 },
		4,
	)
	// 17 slots over 4 chunks: ceil(17/4) = 5, so 5/5/5/2 - the reviewer's first colored paint is
	// one worker's chunk, not the whole band.
	// `assert.deepEqual` is an assertion function (`asserts actual is T`); with both sides the same type
	// the predicate has nothing to narrow, which the type-aware lint reads as a redundant condition.
	// A comparison hands in the unknown value it is really about.
	const actual: unknown = ordered
		.slice(0, 4)
		.map(w => [w.startingLine, w.totalLines])
	assert.deepEqual(actual, [
		[0, 5],
		[5, 5],
		[10, 5],
		[15, 2],
	])
	// More chunks than visible slots never mints empty windows.
	const narrowed: unknown = planWindowOrder(
		diff,
		{ startingLine: 3, totalLines: 2 },
		4,
	)
		.slice(0, 2)
		.map(w => [w.startingLine, w.totalLines])
	assert.deepEqual(narrowed, [
		[3, 1],
		[4, 1],
	])
})

void test('planWindowOrder leads with the visible band, boundaries from the hunks it spans', () => {
	const diff = metadata([hunk(0, 7), hunk(14, 6)], 20)
	const ordered = planWindowOrder(diff, { startingLine: 14, totalLines: 6 })
	// The band is NOT in the cost-ordered plan (an LPT head would be the 13-unit sweep): the
	// reviewer's rows have to color first, whatever the workers would prefer.
	assert.deepEqual(ordered[0], {
		kind: 'sweep',
		startingLine: 14,
		totalLines: 6,
		firstHunk: 1,
		lastHunk: 1,
	})
	const rest: unknown = ordered.slice(1)
	assert.deepEqual(rest, planByCost(diff, planTokenWindows(diff)))
})

void test('planWindowOrder clamps the band to the file and drops an empty one', () => {
	const diff = metadata([hunk(0, 7), hunk(14, 6)], 20)
	const [tail] = planWindowOrder(diff, { startingLine: 18, totalLines: 100 })
	const clamped: unknown = [tail.startingLine, tail.totalLines]
	assert.deepEqual(clamped, [18, 2])
	// Entirely past the last slot: nothing to lead with, so the plain plan stands.
	const past: unknown = planWindowOrder(diff, {
		startingLine: 25,
		totalLines: 5,
	})
	assert.deepEqual(past, planByCost(diff, planTokenWindows(diff)))
	// The renderer reports no range while it settles: same thing.
	const settling: unknown = planWindowOrder(diff, {
		startingLine: 0,
		totalLines: 0,
	})
	assert.deepEqual(settling, planByCost(diff, planTokenWindows(diff)))
})

void test('estimateUnits counts context lines once and change runs by the longer side', () => {
	const diff = metadata([hunk(0, 9, [ctx(2), change(9, 3), ctx(4)])], 9)
	assert.equal(estimateUnits(diff, planTokenWindows(diff)[0]), 15)
})
