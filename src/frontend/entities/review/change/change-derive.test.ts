import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseDiffFromFile } from '@pierre/diffs'

import { changeStableKey, deriveChanges } from './change-derive'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { ChangeState, Decision } from '../model'

// Real parsed diffs (the library is isomorphic, so these run without a DOM). BASE -> NEXT has two
// separate change blocks, split by an unchanged line; NEXT -> LATER moves the remaining block down
// the file, so its identity changes.
const BASE = 'const a = 1\nconst shared = 0\nconst b = 1\n'
const NEXT = 'const a = 2\nconst shared = 0\nconst b = 2\nconst c = 3\n'
const LATER = 'const a = 2\nconst shared = 0\nconst b = 2\nconst c = 4\n'

function diff(oldContents: string, newContents: string): FileDiffMetadata {
	return parseDiffFromFile(
		{ name: 'alpha.ts', contents: oldContents, cacheKey: 'old' },
		{ name: 'alpha.ts', contents: newContents, cacheKey: 'new' },
	)
}

function previousFor(states: ChangeState[]): Map<string, ChangeState> {
	return new Map(states.map(state => [state.id, state]))
}

await test('deriveChanges keys each block by path + stableKey, in diff order', () => {
	const derived = deriveChanges(diff(BASE, NEXT), 'alpha.ts')
	assert.equal(
		derived.length,
		2,
		'two change blocks, split by the unchanged line',
	)
	assert.equal(derived[0].path, 'alpha.ts')
	assert.ok(Object.is(derived[0].id, `alpha.ts:${derived[0].stableKey}`))
	assert.equal(derived[0].hunkIndex, 0)
	assert.equal(
		derived[0].changeIndex,
		0,
		'the block index within the hunk, context included',
	)
	assert.equal(
		derived[1].changeIndex,
		2,
		'the second block sits after the context entry',
	)
	assert.equal(derived[0].side, 'additions')
	assert.equal(derived[0].lineNumber, 1)
	assert.equal(derived[0].endLine, 1)
	assert.equal(derived[0].status, 'pending', 'no decision record yet')
	assert.equal(derived[0].title, '1 removed · 1 added')
	assert.equal(derived[1].title, '1 removed · 2 added')
})

await test('deriveChanges takes a block status from its explicit decision record', () => {
	const blocks = diff(BASE, NEXT).hunks[0].hunkContent.filter(
		part => part.type === 'change',
	)
	const key = `alpha.ts:${changeStableKey(blocks[1])}`
	const decisions: Decision[] = [
		{
			key,
			status: 'rejected',
			reviewedHash: 'hash-at-review',
			path: 'alpha.ts',
			lineNumber: 3,
			side: 'additions',
			title: '1 removed · 2 added',
		},
	]
	const derived = deriveChanges(diff(BASE, NEXT), 'alpha.ts', decisions)
	assert.equal(
		derived[0].status,
		'pending',
		'the unreferenced block stays pending',
	)
	assert.equal(derived[1].status, 'rejected')
	assert.equal(derived[1].reviewedHash, 'hash-at-review')
})

await test('deriveChanges carries stage metadata forward for a block that keeps its id', () => {
	const first = deriveChanges(diff(BASE, NEXT), 'alpha.ts')
	first[1].stageable = true
	first[1].contentHash = 'content-hash'
	const again = deriveChanges(
		diff(BASE, NEXT),
		'alpha.ts',
		[],
		previousFor(first),
	)
	assert.equal(again[1].stageable, true)
	assert.equal(again[1].contentHash, 'content-hash')
})

await test('deriveChanges carries nothing onto a block whose id changed', () => {
	// The identity is the block's position and line counts - a block that moved gets a new id, so
	// the previous record (and its stage metadata) does not follow it.
	const previous = previousFor(deriveChanges(diff(BASE, NEXT), 'alpha.ts'))
	const [moved] = deriveChanges(diff(NEXT, LATER), 'alpha.ts', [], previous)
	assert.notEqual(moved.id, previous.get(`alpha.ts:${moved.stableKey}`)?.id)
	assert.equal(moved.stageable, undefined)
	assert.equal(moved.contentHash, undefined)
})
