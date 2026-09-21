import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	placeholderRows,
	PLACEHOLDER_MIN_LINES,
	shouldPlaceholder,
} from './placeholder-slice'

// The placeholder is the only content on screen while a cold file's parse runs, so its slice has to
// be exactly the file's opening lines: an off-by-one there puts a wrong line number - or the whole
// unsplit remainder of a huge file - in front of a reviewer who is reading the file as truth.

void test('rows are the file prefix, numbered from one', () => {
	const contents = Array.from(
		{ length: 200 },
		(_, i) => `line ${i + 1}`,
	).join('\n')
	const rows = placeholderRows(contents, 3)
	assert.deepEqual(rows, [
		{ no: 1, text: 'line 1' },
		{ no: 2, text: 'line 2' },
		{ no: 3, text: 'line 3' },
	])
})

void test('a trailing newline is not a line, a missing one changes nothing', () => {
	assert.deepEqual(placeholderRows('a\nb\n', 64), [
		{ no: 1, text: 'a' },
		{ no: 2, text: 'b' },
	])
	assert.deepEqual(placeholderRows('a\nb', 64), [
		{ no: 1, text: 'a' },
		{ no: 2, text: 'b' },
	])
	assert.deepEqual(placeholderRows('only\n', 64), [{ no: 1, text: 'only' }])
})

void test('a file longer than the slice keeps its remainder out of the last row', () => {
	// split's limit leaves the untouched remainder in the final slot; painting it would put a
	// multi-megabyte "line" in the pane.
	const contents = Array.from(
		{ length: 5_000 },
		(_, i) => `line ${i + 1}`,
	).join('\n')
	const rows = placeholderRows(contents, 4)
	assert.equal(rows.length, 4)
	// The comparison sites in this file type the actual as `unknown`: `assert.deepEqual` is an
	// assertion function (`asserts actual is T`), and two sides of the same type leave its predicate
	// nothing to narrow - the runtime deep equality is what the test is about.
	const texts: unknown = rows.map(row => row.text)
	assert.deepEqual(texts, ['line 1', 'line 2', 'line 3', 'line 4'])
})

void test('an empty file paints nothing', () => {
	assert.deepEqual(placeholderRows('', 64), [])
	// A single trailing newline is one (empty) line, which is what the diff numbers too.
	assert.deepEqual(placeholderRows('\n', 64), [{ no: 1, text: '' }])
})

void test('an over-long line is truncated, not carried whole', () => {
	const rows = placeholderRows(`${'x'.repeat(5_000)}\nsecond`, 64)
	assert.equal(rows.length, 2)
	assert.equal(rows[0].text.length, 401)
	assert.ok(rows[0].text.endsWith('…'))
	assert.equal(rows[1].text, 'second')
})

void test('the provisional paint engages strictly over the line budget', () => {
	const atBudget = Array.from(Array(PLACEHOLDER_MIN_LINES), () => 'x').join(
		'\n',
	)
	assert.ok(!shouldPlaceholder(atBudget))
	assert.ok(shouldPlaceholder(`${atBudget}\n`))
})
