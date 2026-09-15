import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSkeleton, MergeGrid } from './merge'

import type { ThemedDiffResult } from '@pierre/diffs'
import type { WindowSpec } from './windows'

// Plain rows are opaque values here (the real ones are hast ElementContent nodes): one Text
// node per row is all the merge contract needs to assert about routing.
const row = (nodeValue: string): { type: 'text'; value: string } => ({
	type: 'text',
	value: nodeValue,
})
const cell = (letter: string): { type: 'text'; value: string } =>
	row(`${letter}-row`)
const plainResult = (d: string[], a: string[]): ThemedDiffResult => ({
	code: { deletionLines: d.map(cell), additionLines: a.map(cell) },
	themeStyles: '',
	baseThemeType: 'dark',
})
const cluster = (startingLine: number, totalLines: number): WindowSpec => ({
	kind: 'cluster',
	startingLine,
	totalLines,
	firstHunk: 0,
	lastHunk: 0,
})

void test('createSkeleton copies row grids so window merges cannot mutate the cached plain render', () => {
	const plain = plainResult(['a', 'b'], ['c'])
	const skeleton = createSkeleton(plain)
	skeleton.code.deletionLines[0] = cell('x')
	assert.deepEqual(plain.code.deletionLines, [cell('a'), cell('b')])
	assert.deepEqual(skeleton.code.deletionLines, [cell('x'), cell('b')])
})

void test('MergeGrid scatters window rows at their per-side content indexes', () => {
	const merged = new MergeGrid(
		createSkeleton(plainResult(['p0', 'p1', 'p2'], ['q0'])),
	)
	merged.mergeWindow(cluster(0, 3), {
		code: {
			deletionLines: [row('t0'), row('t1')],
			additionLines: [row('u0')],
		},
		positions: { deletion: [2, 0], addition: [0] },
	})
	assert.deepEqual(merged.result().code.deletionLines, [
		row('t1'),
		cell('p1'),
		row('t0'),
	])
	assert.deepEqual(merged.result().code.additionLines, [row('u0')])
})

void test('merging the full-file window replaces every row in place', () => {
	const merged = new MergeGrid(
		createSkeleton(plainResult(['p0', 'p1'], ['q0', 'q1'])),
	)
	merged.mergeWindow(cluster(0, 2), {
		code: {
			deletionLines: [row('t0'), row('t1')],
			additionLines: [row('u0'), row('u1')],
		},
		positions: { deletion: [0, 1], addition: [0, 1] },
	})
	assert.deepEqual(merged.result().code.deletionLines, [row('t0'), row('t1')])
	assert.deepEqual(merged.result().code.additionLines, [row('u0'), row('u1')])
})

void test('merge keeps theme styles and base theme type from the skeleton render', () => {
	const merged = new MergeGrid(createSkeleton(plainResult(['p0'], ['q0'])))
	merged.mergeWindow(cluster(0, 1), {
		code: { deletionLines: [], additionLines: [] },
		positions: { deletion: [], addition: [] },
	})
	assert.equal(merged.result().themeStyles, '')
	assert.equal(merged.result().baseThemeType, 'dark')
})

void test('merge throws when the worker walk disagrees with its token rows (drift)', () => {
	const skeleton = createSkeleton(plainResult(['p0', 'p1'], []))
	assert.throws(
		() =>
			new MergeGrid(skeleton).mergeWindow(cluster(0, 2), {
				code: {
					deletionLines: [row('t0'), row('t1')],
					additionLines: [],
				},
				positions: { deletion: [0], addition: [] },
			}),
		/rows=2 but positions=1/,
	)
})

void test('merge throws on a duplicate content index inside one window (overlapping walk)', () => {
	const skeleton = createSkeleton(plainResult(['p0'], []))
	assert.throws(
		() =>
			new MergeGrid(skeleton).mergeWindow(cluster(0, 1), {
				code: {
					deletionLines: [row('t0'), row('t1')],
					additionLines: [],
				},
				positions: { deletion: [0, 0], addition: [] },
			}),
		/duplicate content index/,
	)
})
