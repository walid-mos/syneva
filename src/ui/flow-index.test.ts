import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { deriveFlowIndex } from './flow-index'

import type { ChangeState, ReviewComment, ReviewState } from './types'

// flow-index is the bulk mirror of the per-path predicates (fileFullySkimmed/fileOutOfFlow in
// skim.ts, fileFinished/fileObjections/fileReviewState in changes.ts). Those read the live store,
// so parity is pinned here against hand-derived expectations over a fixture that exercises every
// classification the originals encode.

function change(
	over: Partial<ChangeState> & { id: string; path: string },
): ChangeState {
	return {
		hunkIndex: 0,
		side: 'additions',
		lineNumber: 1,
		title: '',
		status: 'pending',
		...over,
	}
}
function comment(
	over: Partial<ReviewComment> & { id: string; path: string },
): ReviewComment {
	return {
		side: 'additions',
		lineNumber: 1,
		body: '',
		createdAt: 't',
		updatedAt: 't',
		status: 'open',
		...over,
	}
}
// A file as the index reads it: path + hunks, plus whatever a case overrides (the rename
// stamps). Typed off the real shape, so the fixture cannot drift from the state it mirrors.
type IndexedFile = ReviewState['files'][number]

function file(path: string, over: Partial<IndexedFile> = {}): IndexedFile {
	return {
		path,
		hasHunks: false,
		added: 0,
		removed: 0,
		contentHash: `H-${path}`,
		...over,
	}
}

const state = {
	files: [
		file('plain.ts'), // in flow, pending
		file('guide-skim.ts'), // guide file-level skim → fully skimmed
		file('block-skim.ts'), // every block skim-stamped → fully skimmed
		file('part-skim.ts'), // one of two blocks skimmed → in flow
		file('pure-rename.ts', {
			renamePure: true,
			oldPath: 'old.ts',
			newPath: 'pure-rename.ts',
		}),
		file('approved.ts'), // finished, no objections → approved
		file('rejected.ts'), // finished + rejected hunk → changes-requested
		file('commented.ts'), // finished + open user change comment → changes-requested
		file('stale.ts'), // signed off but hash no longer matches → pending again
	],
	changes: [
		change({ id: 'c1', path: 'plain.ts' }),
		change({
			id: 'c2',
			path: 'block-skim.ts',
			skim: { reason: 'gen' },
		}),
		change({
			id: 'c3',
			path: 'block-skim.ts',
			skim: { reason: 'gen' },
		}),
		change({
			id: 'c4',
			path: 'part-skim.ts',
			skim: { reason: 'gen' },
		}),
		change({ id: 'c5', path: 'part-skim.ts' }),
		change({ id: 'c6', path: 'rejected.ts' }),
	],
	comments: [
		comment({ id: 'm1', path: 'commented.ts', intent: 'action' }), // open user change → objection
		comment({ id: 'm2', path: 'plain.ts', intent: 'question' }), // question → NOT an objection
		comment({ id: 'm3', path: 'approved.ts', role: 'agent' }), // agent reply → NOT an objection
		comment({
			id: 'm4',
			path: 'rejected.ts',
			status: 'resolved',
			intent: 'action',
		}), // resolved → not
	],
	decisions: [
		{
			key: 'rejected.ts:k',
			path: 'rejected.ts',
			status: 'rejected',
			lineNumber: 1,
			side: 'additions',
			title: '',
		},
		{
			key: 'plain.ts:k',
			path: 'plain.ts',
			status: 'accepted',
			lineNumber: 1,
			side: 'additions',
			title: '',
		},
	],
	reviewedFiles: ['approved.ts', 'rejected.ts', 'commented.ts', 'stale.ts'],
	reviewedFileHashes: {
		'approved.ts': 'H-approved.ts',
		'rejected.ts': 'H-rejected.ts',
		'commented.ts': 'H-commented.ts',
		'stale.ts': 'OLD-HASH', // agent rewrote it since sign-off
	},
	guide: {
		overview: 'o',
		files: [
			{
				path: 'guide-skim.ts',
				category: 'Core',
				order: 0,
				orientation: 'x',
				skim: true,
			},
		],
	},
} satisfies NonNullable<Parameters<typeof deriveFlowIndex>[0]>

void test('flow-index: skim/rename flow classification mirrors the per-path predicates', () => {
	const ix = deriveFlowIndex(state)
	const fullySkimmed = [...ix.fullySkimmed]
	fullySkimmed.sort()
	const expectedFullySkimmed = ['block-skim.ts', 'guide-skim.ts']
	assert.ok(isDeepStrictEqual(fullySkimmed, expectedFullySkimmed))
	const outOfFlow = [...ix.outOfFlow]
	outOfFlow.sort()
	const expectedOutOfFlow = [
		'block-skim.ts',
		'guide-skim.ts',
		'pure-rename.ts',
	]
	assert.ok(isDeepStrictEqual(outOfFlow, expectedOutOfFlow))
	// Partial skim and plain files stay in flow.
	assert.ok(!ix.outOfFlow.has('part-skim.ts'))
	assert.ok(!ix.outOfFlow.has('plain.ts'))
})

void test('flow-index: finished/reviewState mirror fileFinished/fileObjections/fileReviewState', () => {
	const ix = deriveFlowIndex(state)
	assert.equal(ix.reviewState('plain.ts'), 'pending') // never signed off
	assert.equal(ix.reviewState('approved.ts'), 'approved') // finished, agent comment ≠ objection
	assert.equal(ix.reviewState('rejected.ts'), 'changes-requested') // rejected decision
	assert.equal(ix.reviewState('commented.ts'), 'changes-requested') // open user change comment
	assert.equal(ix.reviewState('stale.ts'), 'pending') // hash mismatch voids the sign-off
	assert.equal(ix.finished('stale.ts'), false)
	assert.equal(ix.finished('approved.ts'), true)
	assert.equal(ix.finished('ghost.ts'), false) // not a file at all
})

void test('flow-index: groups changes and comments by path; absent paths have no entry', () => {
	const ix = deriveFlowIndex(state)
	assert.equal(ix.changesByPath.get('block-skim.ts')?.length, 2)
	assert.equal(ix.commentsByPath.get('rejected.ts')?.length, 1)
	assert.equal(ix.changesByPath.get('approved.ts'), undefined)
})

void test('flow-index: null state derives an empty index', () => {
	const ix = deriveFlowIndex(null)
	assert.equal(ix.outOfFlow.size, 0)
	assert.equal(ix.reviewState('anything'), 'pending')
})

void test('the distilled set mirrors reviewState approved, and is empty when the pref is off', () => {
	// a.ts signed off against its CURRENT content and clean → distilled; b.ts has a
	// rejection → changes-requested, never distilled; c.ts's sign-off predates its content
	// (stale hash) → not finished, not distilled.
	const idxState = {
		changes: [],
		comments: [],
		files: [
			{
				path: 'a.ts',
				contentHash: 'ha',
				added: 1,
				removed: 0,
				hasHunks: true,
			},
			{
				path: 'b.ts',
				contentHash: 'hb',
				added: 1,
				removed: 0,
				hasHunks: true,
			},
			{
				path: 'c.ts',
				contentHash: 'hc2',
				added: 1,
				removed: 0,
				hasHunks: true,
			},
		],
		decisions: [
			{
				key: 'b.ts:k',
				status: 'rejected',
				path: 'b.ts',
				lineNumber: 1,
				side: 'additions',
				title: '',
			},
		],
		reviewedFiles: ['a.ts', 'c.ts'],
		reviewedFileHashes: { 'a.ts': 'ha', 'c.ts': 'hc1' },
	} satisfies NonNullable<Parameters<typeof deriveFlowIndex>[0]>
	const on = deriveFlowIndex(idxState, { distill: true })
	assert.ok(on.distilled.has('a.ts'))
	assert.ok(!on.distilled.has('b.ts'))
	assert.ok(!on.distilled.has('c.ts'))
	// The fold mirrors reviewState: a rejected-but-finished file is changes-requested (b.ts
	// has no sign-off yet, so it reads plainly pending; the rejection only colors finished files).
	assert.equal(on.reviewState('a.ts'), 'approved')
	assert.equal(on.reviewState('b.ts'), 'pending')
	assert.equal(on.reviewState('c.ts'), 'pending')
	// Off (or default): the set is EMPTY, so call sites can read it unconditionally.
	const off = deriveFlowIndex(idxState, { distill: false })
	assert.equal(off.distilled.size, 0)
})
