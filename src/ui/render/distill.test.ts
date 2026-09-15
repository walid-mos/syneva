import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { distillAccepted } from './distill.js'

import type {
	ChangeContent,
	ContextContent,
	FileDiffMetadata,
	Hunk,
} from '@pierre/diffs'

// Same hand-built shape as linemap.test's fixture (one hunk, three change blocks), but
// with the line arrays POPULATED - distill reads the parsed rows, the map only indexes them.
//
//   raw old (deletions)        raw new (additions)
//   1  'o1' ctx                1  'n1' ctx
//   2  'o2' ─┐ block A         2  'n2' ─┐ block A (2 del → 3 add)
//   3  'o3' ─┘                3  'n3'  │
//                             4  'n4' ─┘
//   4  'o4' ctx                5  'n5' ctx
//   5  'o5' ─  block B         6  'n6' ─┐ block B (1 del → 2 add)
//                             7  'n7' ─┘
//   6  'o6' ctx                8  'n8' ctx
//   7  'o7' ─┐ block C         -       (3 del → 0 add, pure deletion)
//   8  'o8'  │
//   9  'o9' ─┘
//   10 'o10' ctx               9  'n9' ctx
//
// resolveRegion's row semantics, which distill preserves: a merged context/accepted row
// pushes the SAME addition-side object into BOTH arrays; a change entry's rows hit their
// own side only.
const EMPTY_HUNK: Hunk = {
	collapsedBefore: 0,
	additionStart: 1,
	additionCount: 0,
	additionLines: 0,
	additionLineIndex: 0,
	deletionStart: 1,
	deletionCount: 0,
	deletionLines: 0,
	deletionLineIndex: 0,
	noEOFCRAdditions: false,
	noEOFCRDeletions: false,
	splitLineStart: 0,
	splitLineCount: 0,
	unifiedLineStart: 0,
	unifiedLineCount: 0,
	hunkContent: [],
}

function ctx(lines: number, delIdx: number, addIdx: number): ContextContent {
	return {
		type: 'context',
		lines,
		deletionLineIndex: delIdx,
		additionLineIndex: addIdx,
	}
}

function chg(
	dels: number,
	adds: number,
	delIdx: number,
	addIdx: number,
): ChangeContent {
	return {
		type: 'change',
		deletions: dels,
		additions: adds,
		deletionLineIndex: delIdx,
		additionLineIndex: addIdx,
	}
}

function fixture(): FileDiffMetadata {
	return {
		name: 'fixture.ts',
		type: 'change',
		hunks: [
			{
				...EMPTY_HUNK,
				hunkContent: [
					ctx(1, 0, 0),
					chg(2, 3, 1, 1), // block A
					ctx(1, 3, 4),
					chg(1, 2, 4, 5), // block B
					ctx(1, 5, 7),
					chg(3, 0, 6, 8), // block C
					ctx(1, 9, 8),
				],
			},
		],
		splitLineCount: 0,
		unifiedLineCount: 0,
		isPartial: true,
		deletionLines: [
			'o1',
			'o2',
			'o3',
			'o4',
			'o5',
			'o6',
			'o7',
			'o8',
			'o9',
			'o10',
		],
		additionLines: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'],
	}
}

void test('distillAccepted with no cuts returns the diff untouched', () => {
	const diff = fixture()
	// Same structure in, same structure out: with no cuts the transform is a pass-through.
	assert.ok(isDeepStrictEqual(distillAccepted(diff, []), diff))
})

void test('cut blocks drop their rows and keep their content slot as a zero-row placeholder', () => {
	const diff = fixture()
	const out = distillAccepted(diff, [
		{ hunkIndex: 0, changeIndex: 1, status: 'cut' },
	])
	const [hunk] = out.hunks
	assert.ok(hunk.hunkContent.length === diff.hunks[0].hunkContent.length)
	// Block A's slot: a zero-row context placeholder at the SAME (hunk, change) index; the
	// kept change blocks B and C keep their types at their invariant positions.
	assert.ok(
		hunk.hunkContent[1].type === 'context' &&
			hunk.hunkContent[1].lines === 0,
	)
	assert.equal(hunk.hunkContent[3].type, 'change')
	assert.equal(hunk.hunkContent[5].type, 'change')
	// The dropped 2 deletions / 3 additions vanish; the kept rows re-stamp. Merged context
	// rows carry the addition-side object on both sides (resolveRegion's contract); block C
	// is NOT cut here, so its deletions survive verified further down the array.
	assert.ok(
		isDeepStrictEqual(out.deletionLines, [
			'n1',
			'n5',
			'o5',
			'n8',
			'o7',
			'o8',
			'o9',
			'n9',
		]),
	)
	assert.ok(
		isDeepStrictEqual(out.additionLines, [
			'n1',
			'n5',
			'n6',
			'n7',
			'n8',
			'n9',
		]),
	)
})

void test('a cut pure-deletion block drops nothing at all', () => {
	// Accepted block C is a 3 del → 0 add band: replaying it already produced ZERO context
	// rows (accept splices the deletions out), so distilling it changes nothing.
	const diff = fixture()
	const out = distillAccepted(diff, [
		{ hunkIndex: 0, changeIndex: 5, status: 'cut' },
	])
	assert.ok(
		isDeepStrictEqual(out.deletionLines, [
			'n1',
			'o2',
			'o3',
			'n5',
			'o5',
			'n8',
			'n9',
		]),
	)
	assert.ok(
		isDeepStrictEqual(out.additionLines, [
			'n1',
			'n2',
			'n3',
			'n4',
			'n5',
			'n6',
			'n7',
			'n8',
			'n9',
		]),
	)
})

void test('re-stamped kept entries address the COMPRESSED layout, not the raw one', () => {
	// Cut block A: the context after it sits two rows earlier on the deletion side (o4 was
	// source index 3, now index 1) and the kept change block B re-stamps after that.
	const diff = fixture()
	const out = distillAccepted(diff, [
		{ hunkIndex: 0, changeIndex: 1, status: 'cut' },
	])
	const [hunk] = out.hunks
	const [after] = hunk.hunkContent.slice(2)
	assert.ok(
		after.type === 'context' &&
			after.lines === 1 &&
			after.deletionLineIndex === 1 &&
			after.additionLineIndex === 1,
	)
	const [blockB] = hunk.hunkContent.slice(3)
	assert.ok(
		blockB.type === 'change' &&
			blockB.deletionLineIndex === 2 &&
			blockB.additionLineIndex === 2,
	)
	// Row counters shrank with every dropped row; split/unified counts stay consistent.
	assert.equal(hunk.additionCount, 6)
	assert.equal(hunk.deletionCount, 8)
	assert.equal(out.splitLineCount, 9)
	assert.equal(out.unifiedLineCount, 10)
})
