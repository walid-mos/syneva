import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { CONTENT_READ_LIMIT } from '../content-reads.js'
import { gitStats } from '../git/repo.js'

import { buildReviewState } from './build.js'

const DELETED_FILE_COUNT = 100
const MODIFIED_FILE_COUNT = 8
const UNTRACKED_FILE_COUNT = 8
const MOVED_FILE = 'moved.txt'
const LAST_DELETED_FILE = deletedName(DELETED_FILE_COUNT - 1)

function deletedName(index: number): string {
	return `deleted-${String(index).padStart(3, '0')}.txt`
}

const contents = (index: number): string =>
	`unique original contents for document ${index}\n`

// A working tree with one of every content-read the builder performs: 100 deletions (each read at
// its index side to hash it for the move pairing), a plain-mv'ed copy of the last of them, untracked
// additions (read from the working tree), and modifications (read from the working tree to stamp the
// new side). The deletion sweep is the fan-out a whole-tree `Promise.all` pushed past the process's
// file-descriptor budget: the failing reads degraded to "" and the pairing silently stopped resolving.
function sweepRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'galley-sweep-'))
	const g = (args: string[]): string =>
		execFileSync('git', args, { cwd: dir }).toString()
	g(['init', '-q'])
	g(['config', 'user.email', 't@t.co'])
	g(['config', 'user.name', 'tester'])
	for (let index = 0; index < DELETED_FILE_COUNT; index++)
		writeFileSync(path.join(dir, deletedName(index)), contents(index))
	for (let index = 0; index < MODIFIED_FILE_COUNT; index++)
		writeFileSync(path.join(dir, `modified-${index}.txt`), contents(index))
	g(['add', '.'])
	g(['commit', '-qm', 'init'])
	for (let index = 0; index < DELETED_FILE_COUNT; index++)
		unlinkSync(path.join(dir, deletedName(index)))
	writeFileSync(path.join(dir, MOVED_FILE), contents(DELETED_FILE_COUNT - 1))
	for (let index = 0; index < MODIFIED_FILE_COUNT; index++)
		writeFileSync(
			path.join(dir, `modified-${index}.txt`),
			`${contents(index)}edited\n`,
		)
	for (let index = 0; index < UNTRACKED_FILE_COUNT; index++)
		writeFileSync(
			path.join(dir, `untracked-${index}.txt`),
			`new ${index}\n`,
		)
	return dir
}

void test('a whole-tree sweep pairs the moved file and holds its content reads to the limit', async () => {
	const dir = sweepRepo()
	try {
		gitStats.fileReads = 0
		gitStats.readsInFlight = 0
		gitStats.peakReadsInFlight = 0
		const state = await buildReviewState(dir, {
			mode: 'repo',
			session: 'sweep',
		})
		assert.ok(state, 'built a review state for the sweep')
		// 99 deletions kept + the merged move + the modifications + the untracked additions.
		assert.ok(
			Object.is(
				state.files.length,
				DELETED_FILE_COUNT + MODIFIED_FILE_COUNT + UNTRACKED_FILE_COUNT,
			),
		)
		assert.deepEqual(
			state.files
				.filter(file => file.renamePure)
				.map(file => ({ path: file.path, oldPath: file.oldPath })),
			[{ path: MOVED_FILE, oldPath: LAST_DELETED_FILE }],
		)
		// Every deletion except the paired one is still its own row ...
		assert.ok(
			Object.is(
				state.files.filter(file => file.changeKind === 'deleted')
					.length,
				DELETED_FILE_COUNT - 1,
			),
		)
		// ... and the sweep really read each deleted index side (the reads the bound applies to).
		assert.ok(
			gitStats.fileReads >= DELETED_FILE_COUNT,
			`expected a read per deleted file, saw ${gitStats.fileReads}`,
		)
		assert.ok(
			gitStats.peakReadsInFlight <= CONTENT_READ_LIMIT,
			`peak ${gitStats.peakReadsInFlight} content reads in flight`,
		)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
