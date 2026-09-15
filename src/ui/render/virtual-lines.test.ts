import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { parseDiffFromFile } from '@pierre/diffs'

import { virtualLines } from './virtual-lines'

const before = Array.from(
	{ length: 100 },
	(_, index) => `line ${index + 1}\n`,
).join('')
const diff = parseDiffFromFile(
	{ name: 'a.txt', contents: before },
	{
		name: 'a.txt',
		contents: before.replace('line 50\n', 'replacement\nextra\n'),
	},
)

void test('window-independent navigation includes distant lines in expanded mode', () => {
	const rows = virtualLines(diff, {
		style: 'unified',
		expanded: true,
		threshold: 0,
	})
	assert.equal(rows[0].line, 1)
	assert.equal(rows.at(-1)?.line, 101)
	assert.deepEqual(
		rows.filter(row => row.change).map(row => [row.side, row.line]),
		[
			['deletions', 50],
			['additions', 50],
			['additions', 51],
		],
	)
})

void test('collapsed context is not navigable until its region is expanded', () => {
	const collapsed = virtualLines(diff, {
		style: 'unified',
		expanded: new Map(),
		threshold: 0,
	})
	assert.equal(
		collapsed.some(row => row.line === 1),
		false,
	)
	assert.equal(
		collapsed.some(row => row.line === 101),
		false,
	)
	const expanded = virtualLines(diff, {
		style: 'unified',
		expanded: new Map([[0, { fromStart: 2, fromEnd: 1 }]]),
		threshold: 0,
	})
	assert.ok(
		isDeepStrictEqual(
			expanded.slice(0, 2).map(row => row.line),
			[1, 2],
		),
	)
	assert.equal(
		expanded.some(row => row.line === 3),
		false,
	)
})

void test('split navigation pairs unequal change sides and shifted context coordinates', () => {
	const rows = virtualLines(diff, {
		style: 'split',
		expanded: true,
		threshold: 0,
	})
	const replacement = rows.find(row => row.line === 50)
	assert.deepEqual(replacement?.alt, { side: 'deletions', line: 50 })
	assert.equal(rows.find(row => row.line === 51)?.alt, undefined)
	assert.deepEqual(rows.find(row => row.line === 52)?.alt, {
		side: 'deletions',
		line: 51,
	})
	assert.equal(rows.length, 101)
})
