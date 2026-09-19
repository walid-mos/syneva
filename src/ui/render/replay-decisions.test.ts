import assert from 'node:assert/strict'
import { test } from 'node:test'

import { diffAcceptRejectHunk, parseDiffFromFile } from '@pierre/diffs'

import { planReplayCalls } from './replay-plan'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { DecidedPosition } from '../linemap'

// One hunk carrying two separate changed blocks (close enough that jsdiff keeps them in one hunk,
// far enough that they stay two entries), so a hunk has more than one decision to group.
const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join('')
const diff = parseDiffFromFile(
	{ name: 'a.txt', contents: before },
	{
		name: 'a.txt',
		contents: before
			.replace('line 5\n', 'five\n')
			.replace('line 9\n', 'nine\n'),
	},
)

// The change-entry indexes of the hunk, the addresses a decision carries.
const changeIndexes = diff.hunks[0].hunkContent
	.map((part, index) => (part.type === 'change' ? index : -1))
	.filter(index => index >= 0)

const accept = (): DecidedPosition[] =>
	changeIndexes.map(changeIndex => ({
		hunkIndex: 0,
		changeIndex,
		status: 'accepted' as const,
	}))

// The options are either the library's bare whole-hunk type or its per-change config.
function optionType(call: { options: string | { type: string } }): string {
	return typeof call.options === 'string' ? call.options : call.options.type
}

void test('the fixture really is one hunk with two changed blocks', () => {
	assert.equal(diff.hunks.length, 1)
	assert.equal(changeIndexes.length, 2)
})

void test('a hunk decided on every change replays in one call', () => {
	const calls = planReplayCalls(diff, accept())
	assert.equal(calls.length, 1)
	// The bare type is the library's whole-hunk form, and it is what makes the call cheap.
	assert.equal(calls[0].options, 'accept')
})

void test('a partially decided hunk keeps one call per decided block', () => {
	const calls = planReplayCalls(diff, [accept()[0]])
	assert.deepEqual(calls, [
		{
			hunkIndex: 0,
			options: { type: 'accept', changeIndex: changeIndexes[0] },
		},
	])
})

void test('mixed decisions in one hunk stay per-block', () => {
	const decided = accept()
	decided[1] = { ...decided[1], status: 'rejected' }
	const calls = planReplayCalls(diff, decided)
	assert.equal(calls.length, 2)
	assert.equal(optionType(calls[0]), 'accept')
	assert.equal(optionType(calls[1]), 'reject')
})

// The shortcut is only sound if the library resolves a whole hunk exactly like each of its
// changes in turn - this is that comparison, run on the real resolver.
void test('whole-hunk accept resolves the same diff as per-change accepts', () => {
	for (const type of ['accept', 'reject'] as const) {
		let perChange: FileDiffMetadata = diff
		for (const changeIndex of changeIndexes)
			perChange = diffAcceptRejectHunk(perChange, 0, {
				type,
				changeIndex,
			})
		const whole = diffAcceptRejectHunk(diff, 0, type)
		// Both sides are Hunk[], and `assert.deepEqual` is an assertion function (`asserts actual is T`):
		// with nothing to narrow, the type-aware lint reads that vacuous predicate as a redundant
		// condition. The actual keeps the type a deep comparison really takes - an unknown value.
		const wholeHunks: unknown = structuredClone(whole.hunks)
		assert.deepEqual(
			wholeHunks,
			structuredClone(perChange.hunks),
			`${type}: whole-hunk form diverged from per-change form`,
		)
	}
})
