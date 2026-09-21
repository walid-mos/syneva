import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { mergeRows } from '@shared/diff-renderer/cursor-rows'

import type { MeasuredRow } from '@shared/diff-renderer/cursor-rows'

// The only fields mergeRows reads - the element it carries in production is not part of the pass.
function row(
	side: MeasuredRow['side'],
	line: number,
	top: number,
): MeasuredRow {
	return { side, line, top }
}

void test('orders rows top-to-bottom regardless of input order', () => {
	const out = mergeRows([
		row('additions', 3, 40),
		row('additions', 1, 0),
		row('additions', 2, 20),
	])
	const lines = out.map(r => r.line)
	assert.ok(isDeepStrictEqual(lines, [1, 2, 3]))
})

void test('merges split-view twins at the same rounded top - additions stays primary', () => {
	// A context line shows in both columns at (near-)identical y; the additions cell sorts first,
	// so it becomes the primary row and the deletions coordinate is preserved as `alt`.
	const out = mergeRows([
		row('deletions', 3, 10.4),
		row('additions', 5, 10.2),
	])
	assert.equal(out.length, 1)
	assert.equal(out[0].side, 'additions')
	assert.equal(out[0].line, 5)
	assert.deepEqual(out[0].alt, { side: 'deletions', line: 3 })
})

void test('keeps rows at distinct tops separate and merges only on rounded equality', () => {
	const out = mergeRows([
		row('additions', 1, 10.2),
		row('deletions', 9, 10.4), // rounds to 10 → merged into the row above as its twin
		row('additions', 2, 30),
	])
	assert.equal(out.length, 2)
	const lines = out.map(r => r.line)
	assert.ok(isDeepStrictEqual(lines, [1, 2]))
	assert.deepEqual(out[0].alt, { side: 'deletions', line: 9 })
	assert.equal(out[1].alt, undefined)
})
