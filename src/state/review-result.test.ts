import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { computeApprovedFiles } from './decisions.js'
import { change, comment, decision, file, state } from './fixtures.js'
import { buildReviewResult } from './review-result.js'

void test('buildReviewResult reads decisions, so a staged-out accepted hunk still appears in accepted[]', () => {
	const s = state({
		mode: 'repo',
		changes: [], // the accepted hunk is gone from the working diff (staged)
		decisions: [
			decision({
				key: 'a.ts:k1',
				path: 'a.ts',
				status: 'accepted',
				lineNumber: 4,
				side: 'additions',
				title: '1 removed · 5 added',
			}),
		],
	})
	const r = buildReviewResult(s, { resultJson: 'r.json', sessionDir: 'd' })
	assert.equal(r.accepted.length, 1)
	assert.equal(r.accepted[0].path, 'a.ts')
	assert.equal(r.accepted[0].lineNumber, 4)
})

void test('buildReviewResult excludes questions from requestedChanges, keeps an action on the same line', () => {
	const s = state({
		comments: [
			comment({
				id: 'q',
				path: 'a.ts',
				lineNumber: 4,
				body: 'why is this here?',
				intent: 'question',
			}),
			comment({
				id: 'a',
				path: 'a.ts',
				lineNumber: 4,
				body: 'rename this',
				intent: 'action',
			}),
		],
	})
	const r = buildReviewResult(s, { resultJson: 'r.json', sessionDir: 'd' })
	assert.equal(r.requestedChanges.length, 1)
	assert.equal(r.requestedChanges[0].body, 'rename this')
})

void test('buildReviewResult.openQuestions lists unanswered questions and drops answered ones', () => {
	const s = state({
		session: 'sess',
		mode: 'repo',
		comments: [
			comment({
				id: 'open',
				path: 'a.ts',
				lineNumber: 4,
				body: 'why here?',
				intent: 'question',
				role: 'user',
				createdAt: '2026-01-01T00:00:00Z',
			}),
			// Answered: a later agent reply lands in the same thread (same path/side/line).
			comment({
				id: 'answered',
				path: 'a.ts',
				lineNumber: 7,
				body: 'and this?',
				intent: 'question',
				role: 'user',
				createdAt: '2026-01-01T00:00:00Z',
			}),
			comment({
				id: 'reply',
				path: 'a.ts',
				lineNumber: 7,
				body: 'because X',
				intent: 'note',
				role: 'agent',
				createdAt: '2026-01-01T00:01:00Z',
			}),
		],
	})
	const r = buildReviewResult(s, { resultJson: 'r.json', sessionDir: 'd' })
	assert.equal(r.openQuestions.length, 1)
	assert.equal(r.openQuestions[0].body, 'why here?')
	assert.equal(r.openQuestions[0].lineNumber, 4)
	// Same shape as an await question - mode/session threaded through.
	assert.equal(r.openQuestions[0].mode, 'repo')
	assert.equal(r.openQuestions[0].session, 'sess')
})

void test('buildReviewResult carries mode/target/base', () => {
	const s = state({ mode: 'pr', target: 'feature-x', base: 'abc123' })
	const r = buildReviewResult(s, { resultJson: 'r.json', sessionDir: 'd' })
	assert.equal(r.mode, 'pr')
	assert.equal(r.target, 'feature-x')
	assert.equal(r.base, 'abc123')
})

void test('buildReviewResult.approvedFiles includes a clean signed-off file', () => {
	const s = state({
		files: [file('a.ts', 'H')],
		reviewedFiles: ['a.ts'],
		reviewedFileHashes: { 'a.ts': 'H' },
	})
	const r = buildReviewResult(s, { resultJson: 'r.json', sessionDir: 'd' })
	assert.ok(isDeepStrictEqual(r.approvedFiles, ['a.ts']))
})

void test('buildReviewResult.approvedFiles excludes a signed-off file with a rejected hunk', () => {
	const s = state({
		files: [file('a.ts', 'H')],
		reviewedFiles: ['a.ts'],
		reviewedFileHashes: { 'a.ts': 'H' },
		decisions: [
			decision({ key: 'a.ts:k1', path: 'a.ts', status: 'rejected' }),
		],
	})
	const r = buildReviewResult(s, { resultJson: 'r.json', sessionDir: 'd' })
	assert.deepEqual(r.approvedFiles, [])
})

void test('buildReviewResult.approvedFiles excludes a signed-off file with an open action comment, keeps one with only a question', () => {
	const s = state({
		files: [file('a.ts', 'H'), file('b.ts', 'H')],
		reviewedFiles: ['a.ts', 'b.ts'],
		reviewedFileHashes: { 'a.ts': 'H', 'b.ts': 'H' },
		comments: [
			comment({
				id: 'c1',
				path: 'a.ts',
				status: 'open',
				role: 'user',
				intent: 'action',
				body: 'fix',
			}),
			comment({
				id: 'c2',
				path: 'b.ts',
				status: 'open',
				role: 'user',
				intent: 'question',
				body: 'why?',
			}),
		],
	})
	const r = buildReviewResult(s, { resultJson: 'r.json', sessionDir: 'd' })
	assert.ok(isDeepStrictEqual(r.approvedFiles, ['b.ts'])) // a.ts has an open change request; b.ts only a question
})

void test('skim never changes approval derivations (display-only)', () => {
	// A skimmed block accepted like any other: it lands in accepted[] and the file approves.
	const s = state({
		files: [file('a.ts', 'H')],
		changes: [
			change({
				id: 'a.ts:k',
				path: 'a.ts',
				stableKey: 'k',
				status: 'accepted',
				skim: { reason: 'imports' },
			}),
		],
		decisions: [
			decision({ key: 'a.ts:k', path: 'a.ts', status: 'accepted' }),
		],
		reviewedFiles: ['a.ts'],
		reviewedFileHashes: { 'a.ts': 'H' },
	})
	assert.ok(isDeepStrictEqual(computeApprovedFiles(s), ['a.ts']))
	const r = buildReviewResult(s, { resultJson: 'r.json', sessionDir: 'd' })
	assert.equal(r.accepted.length, 1)
	assert.ok(isDeepStrictEqual(r.approvedFiles, ['a.ts']))
})
