import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { revealThreads } from './thread-reveals'

void test('a new renderer re-expands the same thread even when the file did not change', () => {
	const original = {}
	const replacement = {}
	const threads = [{ side: 'additions' as const, lineNumber: 10 }]
	let expansions = 0
	const expand = (): void => {
		expansions++
	}
	revealThreads(original, threads, expand)
	revealThreads(original, threads, expand)
	assert.equal(expansions, 1)
	revealThreads(replacement, threads, expand)
	assert.equal(expansions, 2)
})

void test('duplicate comments on a line expand once, but opposite sides remain distinct', () => {
	const expanded: string[] = []
	revealThreads(
		{},
		[
			{ side: 'additions', lineNumber: 10 },
			{ side: 'additions', lineNumber: 10 },
			{ side: 'deletions', lineNumber: 10 },
		],
		(side, line) => expanded.push(`${side}:${line}`),
	)
	assert.ok(isDeepStrictEqual(expanded, ['additions:10', 'deletions:10']))
})
