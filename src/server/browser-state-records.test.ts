import assert from 'node:assert/strict'
import { test } from 'node:test'

import { browserState } from './browser-state.js'

import type { ReviewState } from '../types.js'

const records = {
	changes: [
		{
			id: 'a:k',
			path: 'a',
			hunkIndex: 0,
			lineNumber: 1,
			side: 'additions',
			title: 'Add',
			status: 'accepted',
			stableKey: 'k',
			contentHash: 'H',
			reviewedHash: 'H',
			skim: { reason: 'generated' },
		},
	],
	decisions: [
		{
			key: 'a:k',
			path: 'a',
			lineNumber: 1,
			side: 'additions',
			title: 'Add',
			status: 'accepted',
			reviewedHash: 'H',
		},
	],
	comments: [
		{
			id: 'c',
			path: 'a',
			lineNumber: 1,
			side: 'additions',
			body: 'Why?',
			createdAt: 't',
			updatedAt: 't',
			status: 'open',
			intent: 'question',
			role: 'user',
			anchorText: 'line',
			unanchored: true,
		},
	],
	reviewedFiles: ['a'],
	reviewedFileHashes: { a: 'H' },
	stagedFiles: ['a'],
	stagedChangeKeys: ['a:k'],
	decisionFiles: ['a'],
	guide: {
		overview: 'Review the change',
		focused: true,
		baseDiffHash: 'base',
		files: [
			{
				path: 'a',
				order: 0,
				category: 'Core',
				orientation: 'Check behavior',
				flag: 'Risky',
				skimBlocks: [{ lines: [1, 2], reason: 'generated' }],
			},
		],
	},
} satisfies Partial<ReviewState>
const state: ReviewState = {
	id: 'id',
	session: 's',
	root: '/repo',
	repoHash: 'repo-hash',
	mode: 'pr',
	target: 'feature',
	staged: false,
	head: 'HEAD',
	base: 'main',
	baseDiffHash: 'base',
	createdAt: 't',
	rawDiff: 'backend-only',
	files: [],
	...records,
}
void test('the browser projection retains reviewer records, staging metadata, and guide instructions', () => {
	const projected = browserState(state)
	// These records are part of the browser contract even when no file is currently in the diff
	// (e.g. an accepted block staged out of the working tree). Do not drop or rebuild them.
	assert.deepEqual(projected, {
		root: '/repo',
		session: 's',
		mode: 'pr',
		target: 'feature',
		staged: false,
		baseDiffHash: 'base',
		files: [],
		...records,
	})
})
