import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	EXPAND_LINES_MAX,
	isExpandCapped,
	newLines,
} from '@shared/diff-renderer/expand-cap'

// The cap gate decides whether the "expand unchanged" preference renders the whole file or
// hunks-only. A wrong boundary renders an unbounded DOM for a huge file (the perfect stall this
// gate exists for) or disables the expansion on a normal file (a preference that silently lies).

void test('newLines counts terminal-newline files but tolerates none', () => {
	assert.equal(newLines(''), 1)
	assert.equal(newLines('a\nb\nc'), 3)
	assert.equal(newLines('a\nb\nc\n'), 4)
})

void test('capping engages strictly over the line budget', () => {
	const atBudget = Array.from(Array(EXPAND_LINES_MAX), () => 'x').join('\n')
	const oneOver = `${atBudget}\n`
	assert.ok(newLines(atBudget) === EXPAND_LINES_MAX)
	assert.ok(!isExpandCapped(atBudget))
	assert.ok(isExpandCapped(oneOver))
	assert.ok(newLines(oneOver) === EXPAND_LINES_MAX + 1)
})

void test('normal files never cap', () => {
	assert.ok(!isExpandCapped('a\nb\nc'))
})
