import assert from 'node:assert/strict'
import { test } from 'node:test'

import { defaultFileView, reviewLineCount } from './file-summary'

void test('Markdown with parsed changes opens source; hunkless artifacts open rendered', () => {
	assert.equal(
		defaultFileView({ path: 'changed.md', hasHunks: true }, 'auto'),
		'source',
	)
	assert.equal(
		defaultFileView({ path: 'added.MDX', hasHunks: false }, 'auto'),
		'rendered',
	)
	assert.equal(
		defaultFileView(
			{ path: 'unchanged.markdown', hasHunks: false },
			'auto',
		),
		'rendered',
	)
	assert.equal(
		defaultFileView({ path: 'deleted.md', hasHunks: true }, 'auto'),
		'source',
	)
})

void test('Markdown preferences override the default but never render a code file as Markdown', () => {
	assert.equal(
		defaultFileView({ path: 'changed.md', hasHunks: true }, 'rendered'),
		'rendered',
	)
	assert.equal(
		defaultFileView({ path: 'added.md', hasHunks: false }, 'source'),
		'source',
	)
	assert.equal(
		defaultFileView({ path: 'code.ts', hasHunks: true }, 'rendered'),
		'source',
	)
})

void test('completion counts changed lines, including full additions and deletions with hunks', () => {
	assert.equal(reviewLineCount({ hasHunks: true, added: 3, removed: 2 }), 5)
	assert.equal(reviewLineCount({ hasHunks: true, added: 8, removed: 0 }), 8)
	assert.equal(reviewLineCount({ hasHunks: true, added: 0, removed: 4 }), 4)
})

void test('completion preserves zero for hunkless additions, unchanged files, and pure renames', () => {
	assert.equal(reviewLineCount({ hasHunks: false, added: 8, removed: 0 }), 0)
	assert.equal(reviewLineCount({ hasHunks: false, added: 0, removed: 0 }), 0)
})
