import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { change, comment, decision, file, state } from './fixtures.js'
import { reviewerSavePatch } from './persistence.js'
import { mergeReviewState, readStagedSnapshot } from './reconcile.js'

void test('mergeReviewState carries a prior decision when content is unchanged', async () => {
	const base = state({
		baseDiffHash: 'new',
		files: [file('a.ts')],
		changes: [
			change({
				id: 'a.ts:k1',
				path: 'a.ts',
				stableKey: 'k1',
				contentHash: 'H',
			}),
		],
	})
	const saved = state({
		changes: [
			change({
				id: 'a.ts:k1',
				path: 'a.ts',
				stableKey: 'k1',
				status: 'accepted',
				reviewedHash: 'H',
			}),
		],
	})
	const merged = await mergeReviewState(base, saved)
	assert.equal(merged.changes[0].status, 'accepted')
	assert.equal(merged.changes[0].reviewedHash, 'H')
	assert.equal(merged.baseDiffHash, 'new') // adopts the fresh diff hash
})

void test('reviewerSavePatch replaces only the reviewer-owned fields, leaving server state intact', () => {
	const live = state({
		rawDiff: 'SERVER DIFF',
		files: [file('a.ts')],
		changes: [change({ id: 'a.ts:k1', path: 'a.ts', stableKey: 'k1' })],
		baseDiffHash: 'server-hash',
	})
	Object.assign(
		live,
		reviewerSavePatch({
			decisions: [
				{
					key: 'a.ts:k1',
					status: 'accepted',
					path: 'a.ts',
					lineNumber: 1,
					side: 'additions',
					title: 't',
				},
			],
			comments: [comment({ id: 'c1', path: 'a.ts' })],
			reviewedFiles: ['a.ts'],
			reviewedFileHashes: { 'a.ts': 'FH' },
			decisionFiles: ['a.ts'],
		}),
	)
	assert.ok(isDeepStrictEqual(live.reviewedFiles, ['a.ts']))
	assert.deepEqual(live.reviewedFileHashes, { 'a.ts': 'FH' })
	assert.deepEqual(live.decisionFiles, ['a.ts'])
	assert.equal(live.decisions![0].status, 'accepted')
	assert.equal(live.comments[0].id, 'c1')
	// Server-owned fields are untouched - the wire never carries them.
	assert.equal(live.rawDiff, 'SERVER DIFF')
	assert.equal(live.baseDiffHash, 'server-hash')
	assert.equal(live.changes.length, 1)
})

void test('reviewerSavePatch ignores non-reviewer fields from a stale full-state body', () => {
	// A stale open tab may POST the whole old ReviewState; only the slice is adopted.
	const live = state({ rawDiff: 'SERVER DIFF', baseDiffHash: 'server-hash' })
	Object.assign(
		live,
		reviewerSavePatch({
			reviewedFiles: ['a.ts'],
			rawDiff: 'CLIENT-OWNED DIFF SHOULD BE IGNORED',
			baseDiffHash: 'client-hash',
			files: [file('evil.ts')],
			id: 'spoofed',
		}),
	)
	assert.ok(isDeepStrictEqual(live.reviewedFiles, ['a.ts']))
	assert.equal(live.rawDiff, 'SERVER DIFF')
	assert.equal(live.baseDiffHash, 'server-hash')
	assert.equal(live.files.length, 0)
	assert.equal(live.id, 'id')
})

void test('reviewerSavePatch leaves a field untouched when the body omits it', () => {
	const live = state({
		reviewedFiles: ['keep.ts'],
		comments: [comment({ id: 'c0', path: 'x' })],
	})
	Object.assign(live, reviewerSavePatch({ comments: [] })) // only comments present
	assert.ok(isDeepStrictEqual(live.reviewedFiles, ['keep.ts'])) // omitted - unchanged
	assert.deepEqual(live.comments, []) // present → replaced wholesale
})

void test('reviewerSavePatch then mergeReviewState: a slim-saved decision survives a desk restart', async () => {
	// Save via the slim wire, persist, reload: the decision must reconcile across restart.
	const saved = state({})
	Object.assign(
		saved,
		reviewerSavePatch({
			decisions: [
				{
					key: 'a.ts:k1',
					status: 'accepted',
					reviewedHash: 'H',
					path: 'a.ts',
					lineNumber: 1,
					side: 'additions',
					title: 't',
				},
			],
			reviewedFiles: ['a.ts'],
			reviewedFileHashes: { 'a.ts': 'FH' },
		}),
	)
	const base = state({
		baseDiffHash: 'reload',
		files: [file('a.ts', 'FH')],
		changes: [
			change({
				id: 'a.ts:k1',
				path: 'a.ts',
				stableKey: 'k1',
				contentHash: 'H',
			}),
		],
	})
	const merged = await mergeReviewState(base, saved)
	assert.equal(merged.changes[0].status, 'accepted')
	assert.ok(isDeepStrictEqual(merged.reviewedFiles, ['a.ts']))
})

void test('mergeReviewState resets a decision to pending when content changed (staleness)', async () => {
	const base = state({
		files: [file('a.ts')],
		changes: [
			change({
				id: 'a.ts:k1',
				path: 'a.ts',
				stableKey: 'k1',
				contentHash: 'H',
			}),
		],
	})
	const saved = state({
		changes: [
			change({
				id: 'a.ts:k1',
				path: 'a.ts',
				stableKey: 'k1',
				status: 'accepted',
				reviewedHash: 'OLD',
			}),
		],
	})
	const merged = await mergeReviewState(base, saved)
	assert.equal(merged.changes[0].status, 'pending')
})

void test('mergeReviewState matches a saved decision by stableKey even if the id differs', async () => {
	const base = state({
		files: [file('a.ts')],
		changes: [
			change({
				id: 'a.ts:NEWID',
				path: 'a.ts',
				stableKey: 'k1',
				contentHash: 'H',
			}),
		],
	})
	const saved = state({
		changes: [
			change({
				id: 'a.ts:OLDID',
				path: 'a.ts',
				stableKey: 'k1',
				status: 'rejected',
				reviewedHash: 'H',
			}),
		],
	})
	const merged = await mergeReviewState(base, saved)
	assert.equal(merged.changes[0].status, 'rejected')
})

void test('mergeReviewState retains comments on present files, keeps absent action comments as stale, drops absent notes', async () => {
	const base = state({ files: [file('a.ts')] }) // b.ts is gone from the diff
	const saved = state({
		comments: [
			comment({ id: 'c1', path: 'a.ts' }),
			comment({ id: 'c2', path: 'b.ts', intent: 'action' }),
			comment({ id: 'c3', path: 'b.ts', intent: 'note' }),
		],
	})
	const merged = await mergeReviewState(base, saved)
	const ids = merged.comments.map(commented => commented.id).toSorted()
	assert.deepEqual(ids, ['c1', 'c2'])
	assert.equal(merged.comments.find(c => c.id === 'c1')!.status, 'open')
	assert.equal(merged.comments.find(c => c.id === 'c2')!.status, 'stale')
})

void test('mergeReviewState (reload shape): folds a fresh diff into a live state - carry, stale, comments, hash', async () => {
	// Simulates POST /api/reload: base = fresh diff, saved = live in-memory state.
	const base = state({
		baseDiffHash: 'afterEdit',
		files: [file('a.ts')],
		changes: [
			change({
				id: 'a.ts:k1',
				path: 'a.ts',
				stableKey: 'k1',
				contentHash: 'SAME',
			}),
			change({
				id: 'a.ts:k2',
				path: 'a.ts',
				stableKey: 'k2',
				contentHash: 'CHANGED',
			}),
		],
	})
	const live = state({
		baseDiffHash: 'beforeEdit',
		comments: [
			comment({ id: 'c1', path: 'a.ts', role: 'agent', intent: 'note' }),
		],
		changes: [
			change({
				id: 'a.ts:k1',
				path: 'a.ts',
				stableKey: 'k1',
				status: 'accepted',
				reviewedHash: 'SAME',
			}),
			change({
				id: 'a.ts:k2',
				path: 'a.ts',
				stableKey: 'k2',
				status: 'accepted',
				reviewedHash: 'WAS',
			}),
		],
	})
	const merged = await mergeReviewState(base, live)
	assert.equal(merged.baseDiffHash, 'afterEdit')
	assert.equal(
		merged.changes.find(c => c.stableKey === 'k1')!.status,
		'accepted',
	) // unchanged → carried
	assert.equal(
		merged.changes.find(c => c.stableKey === 'k2')!.status,
		'pending',
	) // changed → re-review
	assert.equal(merged.comments.length, 1) // the agent comment survives
	assert.equal(merged.comments[0].id, 'c1')
})

void test('mergeReviewState keeps an explicit decision whose hunk left the diff (accepted→staged)', async () => {
	// Accepting stages the hunk, so it disappears from the working-tree diff: the
	// rebuilt base has no change for it, yet the decision must survive.
	const base = state({ files: [file('a.ts')], changes: [] })
	const saved = state({
		files: [file('a.ts')],
		changes: [],
		decisions: [
			decision({
				key: 'a.ts:k1',
				path: 'a.ts',
				status: 'accepted',
				reviewedHash: 'H',
				lineNumber: 4,
				title: '1 removed · 5 added',
			}),
		],
	})
	const merged = await mergeReviewState(base, saved)
	assert.equal(merged.decisions!.length, 1)
	assert.equal(merged.decisions![0].status, 'accepted')
})

void test('mergeReviewState drops an explicit decision that went stale (content changed, still visible)', async () => {
	const base = state({
		files: [file('a.ts')],
		changes: [
			change({
				id: 'a.ts:k1',
				path: 'a.ts',
				stableKey: 'k1',
				contentHash: 'NEW',
			}),
		],
	})
	const saved = state({
		files: [file('a.ts')],
		changes: [],
		decisions: [
			decision({
				key: 'a.ts:k1',
				path: 'a.ts',
				status: 'accepted',
				reviewedHash: 'OLD',
			}),
		],
	})
	const merged = await mergeReviewState(base, saved)
	assert.equal(merged.changes[0].status, 'pending') // stale → re-review
	assert.equal(merged.decisions!.length, 0) // and the decision is removed
})

void test('mergeReviewState drops a REJECTED decision whose hunk left the diff (rework honored the rejection)', async () => {
	// The agent reworked the rejected block away: keeping the decision would leave an
	// invisible objection that blocks approval forever.
	const base = state({ files: [file('a.ts')], changes: [] })
	const saved = state({
		files: [file('a.ts')],
		changes: [],
		decisions: [
			decision({
				key: 'a.ts:k1',
				path: 'a.ts',
				status: 'rejected',
				reviewedHash: 'H',
			}),
			decision({
				key: 'a.ts:k2',
				path: 'a.ts',
				status: 'accepted',
				reviewedHash: 'H',
			}),
		],
	})
	const merged = await mergeReviewState(base, saved)
	assert.equal(merged.decisions!.length, 1) // accepted-vanished keeps its staged-out semantics
	assert.equal(merged.decisions![0].status, 'accepted')
})

void test('mergeReviewState keeps a rejected decision whose hunk is still present and unchanged', async () => {
	const base = state({
		files: [file('a.ts')],
		changes: [
			change({
				id: 'a.ts:k1',
				path: 'a.ts',
				stableKey: 'k1',
				contentHash: 'H',
			}),
		],
	})
	const saved = state({
		files: [file('a.ts')],
		changes: [],
		decisions: [
			decision({
				key: 'a.ts:k1',
				path: 'a.ts',
				status: 'rejected',
				reviewedHash: 'H',
			}),
		],
	})
	const merged = await mergeReviewState(base, saved)
	assert.equal(merged.decisions!.length, 1)
	assert.equal(merged.changes[0].status, 'rejected')
})

void test('mergeReviewState migrates a decision + open comment + sign-off across a rename reload (issue 01)', async () => {
	// The reload that introduces a rename: base carries the file at its NEW path (with oldPath set);
	// everything the reviewer recorded is still keyed to the OLD path. Migration re-keys them.
	const renamed = {
		path: 'new.ts',
		hunks: [],
		oldPath: 'old.ts',
		newPath: 'new.ts',
		contentHash: 'H',
		changeKind: 'renamed' as const,
		renamePure: true,
	}
	const base = state({
		files: [renamed],
		changes: [
			change({
				id: 'new.ts:k1',
				path: 'new.ts',
				stableKey: 'k1',
				contentHash: 'H',
			}),
		],
	})
	const saved = state({
		decisions: [
			decision({
				key: 'old.ts:k1',
				path: 'old.ts',
				status: 'accepted',
				reviewedHash: 'H',
			}),
		],
		comments: [
			comment({
				id: 'c1',
				path: 'old.ts',
				intent: 'action',
				anchorText: 'x',
			}),
		],
		reviewedFiles: ['old.ts'],
		reviewedFileHashes: { 'old.ts': 'H' },
	})
	const merged = await mergeReviewState(base, saved)
	// Decision re-keyed to the new path and carried forward (content unchanged).
	assert.equal(merged.changes[0].status, 'accepted')
	assert.ok(
		merged.decisions!.some(
			d => d.key === 'new.ts:k1' && d.path === 'new.ts',
		),
	)
	// The open change-request comment moved to the new path and stays open (not dropped/stale).
	assert.equal(merged.comments.length, 1)
	assert.equal(merged.comments[0].path, 'new.ts')
	assert.equal(merged.comments[0].status, 'open')
	// A pure rename keeps its content hash, so the prior sign-off survives, re-keyed.
	assert.ok(isDeepStrictEqual(merged.reviewedFiles, ['new.ts']))
	assert.equal(merged.reviewedFileHashes!['new.ts'], 'H')
})
void test('mergeReviewState migrates a comment + staged-hunk key across a working-mode move pairing (issue 02)', async () => {
	// A plain mv paired into a rename-pure entry on reload: the file arrives at new.txt with no change
	// blocks, and everything the reviewer left against old.txt migrates to new.txt (issue 01's path).
	const paired = {
		path: 'new.txt',
		hunks: [],
		oldPath: 'old.txt',
		newPath: 'new.txt',
		contentHash: 'H',
		changeKind: 'renamed' as const,
		renamePure: true,
	}
	const base = state({ files: [paired], changes: [] })
	const saved = state({
		comments: [
			comment({
				id: 'c1',
				path: 'old.txt',
				intent: 'action',
				anchorText: 'x',
			}),
		],
		stagedChangeKeys: ['old.txt:additions:1:0:1'],
	})
	const merged = await mergeReviewState(base, saved)
	assert.equal(merged.comments.length, 1)
	assert.equal(merged.comments[0].path, 'new.txt')
	assert.equal(merged.comments[0].status, 'open')
	assert.deepEqual(merged.stagedChangeKeys, ['new.txt:additions:1:0:1'])
})

void test('mergeReviewState keeps a finished file when its content hash is unchanged', async () => {
	const base = state({ files: [file('a.ts', 'H')] })
	const saved = state({
		files: [file('a.ts', 'H')],
		reviewedFiles: ['a.ts'],
		reviewedFileHashes: { 'a.ts': 'H' },
	})
	const merged = await mergeReviewState(base, saved)
	assert.ok(isDeepStrictEqual(merged.reviewedFiles, ['a.ts']))
	assert.equal(merged.reviewedFileHashes!['a.ts'], 'H')
})

void test('mergeReviewState drops a finished file when its content hash changed (re-review)', async () => {
	const base = state({ files: [file('a.ts', 'NEW')] })
	const saved = state({
		files: [file('a.ts', 'OLD')],
		reviewedFiles: ['a.ts'],
		reviewedFileHashes: { 'a.ts': 'OLD' },
	})
	const merged = await mergeReviewState(base, saved)
	assert.deepEqual(merged.reviewedFiles, [])
	assert.deepEqual(merged.reviewedFileHashes, {})
})

void test('mergeReviewState drops a finished file with no recorded hash (old viewed-era session)', async () => {
	const base = state({ files: [file('a.ts', 'H')] })
	const saved = state({ files: [file('a.ts', 'H')], reviewedFiles: ['a.ts'] }) // no reviewedFileHashes
	const merged = await mergeReviewState(base, saved)
	assert.deepEqual(merged.reviewedFiles, [])
})

void test('mergeReviewState (blob-OID migration): a pre-OID review loads - comments + unchanged-block decisions survive, file approval resets once', async () => {
	// A review persisted before file-level keys became git blob OIDs: the file's contentHash is
	// the old 16-char sha slice ("OLDSHA16"), and reviewedFileHashes matches THAT. On the first
	// reload with OID keys, the fresh file entry carries a 40-hex blob OID, so the file hash no
	// longer matches - file approval resets. Block-level hashing is UNCHANGED (a diff block has no
	// blob OID), so a saved decision on an unchanged block still matches and carries forward.
	const base = state({
		files: [file('a.ts', '0123456789abcdef0123456789abcdef01234567')], // fresh: blob OID
		changes: [
			change({
				id: 'a.ts:k1',
				path: 'a.ts',
				stableKey: 'k1',
				contentHash: 'BLOCKHASH',
			}),
		],
	})
	const saved = state({
		files: [file('a.ts', 'OLDSHA16')], // old-format 16-char slice
		comments: [
			comment({
				id: 'c1',
				path: 'a.ts',
				intent: 'action',
				body: 'fix this',
			}),
		],
		reviewedFiles: ['a.ts'],
		reviewedFileHashes: { 'a.ts': 'OLDSHA16' }, // old-format → won't match the OID
		decisions: [
			decision({
				key: 'a.ts:k1',
				path: 'a.ts',
				status: 'accepted',
				reviewedHash: 'BLOCKHASH',
			}),
		],
	})
	const merged = await mergeReviewState(base, saved)
	// Comments carry over.
	assert.equal(merged.comments.length, 1)
	assert.equal(merged.comments[0].id, 'c1')
	// File approval / reviewed-file marks reset (the file-level key format changed).
	assert.deepEqual(merged.reviewedFiles, [])
	assert.deepEqual(merged.reviewedFileHashes, {})
	// An unchanged-content block decision survives (block hashing is unchanged).
	assert.equal(merged.changes[0].status, 'accepted')
	assert.ok(merged.decisions!.some(d => d.key === 'a.ts:k1'))
})

void test('the reviewer save slice never carries skim (changes are server-owned)', () => {
	const s = state({
		changes: [change({ id: 'a.ts:k', path: 'a.ts', stableKey: 'k' })],
	})
	// A stale tab POSTs a whole ReviewState, changes included; reviewerSavePatch must ignore them.
	Object.assign(
		s,
		reviewerSavePatch({
			changes: [
				{
					id: 'a.ts:k',
					path: 'a.ts',
					stableKey: 'k',
					skim: { reason: 'x' },
				},
			],
			comments: [],
		}),
	)
	assert.equal(s.changes[0].skim, undefined) // changes (hence skim) are not a reviewer-save key
	assert.deepEqual(s.comments, []) // comments ARE reviewer-owned, so they applied
})

// ── Staged bookkeeping (staging advances the review baseline) ────────────────

void test('readStagedSnapshot keeps only reviewed files that are staged, and prunes vanished hunk keys', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'galley-staged-'))
	const g = (args: string[]): string =>
		execFileSync('git', args, { cwd: root }).toString()
	try {
		g(['init', '-q'])
		g(['config', 'user.email', 't@t.co'])
		g(['config', 'user.name', 't'])
		await fs.writeFile(path.join(root, 'a.ts'), 'one\n')
		await fs.writeFile(path.join(root, 'b.ts'), 'two\n')
		g(['add', '.'])
		g(['commit', '-qm', 'init'])
		await fs.writeFile(path.join(root, 'a.ts'), 'one changed\n')
		g(['add', 'a.ts']) // only a.ts is staged
		const live = state({
			root,
			files: [file('a.ts'), file('b.ts'), file('c.ts')],
			stagedChangeKeys: [
				'a.ts:additions:1:0:1',
				'b.ts:additions:1:0:1',
				'c.ts:additions:1:0:1',
			],
		})
		const snapshot = await readStagedSnapshot(live)
		assert.ok(isDeepStrictEqual(snapshot.stagedFiles, ['a.ts'])) // staged AND reviewed
		assert.deepEqual(snapshot.stagedChangeKeys, ['a.ts:additions:1:0:1']) // b.ts/c.ts no longer staged
		// The snapshot is returned, never applied: the live state's own fields are untouched.
		assert.deepEqual(live.stagedFiles, [])
		assert.equal(live.stagedChangeKeys?.length, 3)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
