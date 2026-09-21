import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	commentAnchor,
	commentSide,
	isFileLevelLine,
	reanchorComments,
} from './comments.js'
import { anchorTextFor } from './contents.js'
import { comment } from './fixtures.js'

import type { FileContents } from './contents.js'
import type { ReviewComment, ReviewFile } from './review.js'

// ── Re-anchoring ─────────────────────────────────────────────────────────────

// A lean file entry paired with the contents a resolver would return for it (the state embeds
// none - anchoring reads them on demand). `reanchor` wires those contents into reanchorComments.
function withContents(
	filePath: string,
	newContents: string,
	oldContents = newContents,
): { file: ReviewFile; contents: FileContents } {
	return {
		file: {
			path: filePath,
			hunks: [],
			contentHash: 'H',
			changeKind: 'modified',
		},
		contents: { oldContents, newContents },
	}
}
function reanchor(
	comments: ReviewComment[],
	entries: ReturnType<typeof withContents>[],
): ReviewComment[] {
	const map = new Map(entries.map(e => [e.file.path, e.contents]))
	return reanchorComments(
		comments,
		entries.map(e => e.file),
		p => map.get(p),
	)
}

void test("anchorTextFor reads the line from the right side's contents", () => {
	const c = { oldContents: 'o1\no2', newContents: 'n1\nn2\nn3' }
	assert.equal(anchorTextFor(c, 'additions', 2), 'n2')
	assert.equal(anchorTextFor(c, 'deletions', 2), 'o2')
	assert.equal(anchorTextFor(c, 'additions', 9), undefined)
	assert.equal(anchorTextFor(undefined, 'additions', 1), undefined) // file not resolved → no anchor
})

void test('reanchorComments keeps a comment whose line still matches its anchor text', () => {
	const c = comment({
		id: 'c1',
		path: 'a.ts',
		lineNumber: 2,
		anchorText: 'beta',
	})
	const [anchored] = reanchor(
		[c],
		[withContents('a.ts', 'alpha\nbeta\ngamma')],
	)
	assert.equal(anchored.lineNumber, 2)
	assert.equal(anchored.unanchored, false)
})

void test('reanchorComments moves a comment to the unique nearest matching line (endLine shifts too)', () => {
	// Two lines inserted above: "beta" moved from 2 to 4.
	const c = comment({
		id: 'c1',
		path: 'a.ts',
		lineNumber: 2,
		endLine: 3,
		anchorText: 'beta',
	})
	const [anchored] = reanchor(
		[c],
		[withContents('a.ts', 'x\nalpha\ny\nbeta\ngamma')],
	)
	assert.equal(anchored.lineNumber, 4)
	assert.equal(anchored.endLine, 5)
	assert.equal(anchored.unanchored, false)
})

void test('reanchorComments flags an ambiguous or vanished anchor as unanchored', () => {
	const tie = comment({
		id: 'c1',
		path: 'a.ts',
		lineNumber: 2,
		anchorText: 'dup',
	}) // 1 and 3 equidistant
	const gone = comment({
		id: 'c2',
		path: 'a.ts',
		lineNumber: 2,
		anchorText: 'deleted line',
	})
	const [tied, vanished] = reanchor(
		[tie, gone],
		[withContents('a.ts', 'dup\nmid\ndup\nend')],
	)
	assert.equal(tied.unanchored, true)
	assert.equal(tied.lineNumber, 2) // left where it was
	assert.equal(vanished.unanchored, true)
})

void test('reanchorComments best-effort re-anchors a lightly-edited line to the nearest similar one', () => {
	// The anchored line "const total = a + b;" was tweaked to "...a + b + c;" - same line, edited,
	// so its exact text is gone. It should stay put (near its old spot), not fall to the strip.
	const c = comment({
		id: 'c1',
		path: 'a.ts',
		lineNumber: 2,
		anchorText: '  const total = a + b;',
	})
	const [anchored] = reanchor(
		[c],
		[
			withContents(
				'a.ts',
				'function sum() {\n  const total = a + b + c;\n  return total;\n}',
			),
		],
	)
	assert.equal(anchored.unanchored, false)
	assert.equal(anchored.lineNumber, 2)
})

void test('reanchorComments leaves a comment unanchored when no surviving line is similar', () => {
	const c = comment({
		id: 'c1',
		path: 'a.ts',
		lineNumber: 2,
		anchorText: 'const total = a + b;',
	})
	const [anchored] = reanchor(
		[c],
		[withContents('a.ts', 'wholly\ndifferent\ncontent\nhere')],
	)
	assert.equal(anchored.unanchored, true)
})

void test('reanchorComments skips resolved comments and flags legacy ones only when out of range', () => {
	const resolved = comment({
		id: 'c1',
		path: 'a.ts',
		lineNumber: 9,
		status: 'resolved',
		anchorText: 'gone',
	})
	const legacyIn = comment({ id: 'c2', path: 'a.ts', lineNumber: 2 }) // no anchorText
	const legacyOut = comment({ id: 'c3', path: 'a.ts', lineNumber: 7 })
	const [stillResolved, legacyInRange, legacyOutOfRange] = reanchor(
		[resolved, legacyIn, legacyOut],
		[withContents('a.ts', 'one\ntwo')],
	)
	assert.equal(stillResolved.unanchored, undefined) // untouched
	assert.equal(legacyInRange.unanchored, false)
	assert.equal(legacyOutOfRange.unanchored, true)
})

// ── Whole-file comments ─────────────────────────────────────────────────────

void test('reanchorComments never re-anchors a whole-file comment (no unanchored flip, position kept)', () => {
	// The whole-file thread persists lineNumber 0 - a line-based recovery pass would either
	// flag it out of range or move it to a matched line; neither may happen: it anchors to the
	// path, which the caller already matched.
	const c = comment({
		id: 'fc',
		path: 'a.ts',
		lineNumber: 0,
		anchor: 'file',
	})
	const [kept] = reanchor(
		[c],
		// Contents where line 0 could never match anything anyway.
		[withContents('a.ts', 'alpha\nbeta\ngamma')],
	)
	assert.equal(kept.lineNumber, 0)
	assert.equal(kept.anchor, 'file')
	assert.equal(kept.unanchored, undefined) // untouched - no re-anchoring ran at all
})

void test('commentAnchor and commentSide derive the whole-file placeholder pair from line 0, and only line 0', () => {
	assert.equal(commentAnchor(0), 'file')
	assert.equal(commentAnchor(12), undefined)
	// The side placeholder: file-level always additions, real lines keep what the caller sent.
	assert.equal(commentSide('deletions', 0), 'additions')
	assert.equal(commentSide('deletions', 12), 'deletions')
	assert.ok(!isFileLevelLine(1))
})
