import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { file, state } from './fixtures.js'
import { persistReview, writeFileAtomic } from './persistence.js'

import type { ReviewState } from '../types.js'

// ── Lean persistence (issue 04) ──────────────────────────────────────────────

void test('writeFileAtomic writes the content and leaves no temp file behind', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'syneva-atomic-'))
	try {
		const target = path.join(dir, 'review.json')
		await writeFileAtomic(target, '{"ok":true}\n')
		assert.equal(await fs.readFile(target, 'utf8'), '{"ok":true}\n')
		// Overwrite (the reviewer saved again) - the target updates and no *.tmp is stranded.
		await writeFileAtomic(target, '{"ok":false}\n')
		assert.equal(await fs.readFile(target, 'utf8'), '{"ok":false}\n')
		const leftovers = (await fs.readdir(dir)).filter(n =>
			n.endsWith('.tmp'),
		)
		assert.deepEqual(leftovers, [], 'no temp file left after the rename')
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

void test('persistReview writes a lean review - no file contents on disk', async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'syneva-persist-'))
	const oldHome = process.env.HOME
	process.env.HOME = home
	try {
		const s = state({ root: home, files: [file('a.ts', 'H')] })
		const persisted = await persistReview(s)
		const raw = await fs.readFile(persisted.file, 'utf8')
		assert.ok(
			Object.is(
				persisted.stamp.persistFile,
				path.basename(persisted.file),
			),
		)
		assert.equal(
			JSON.parse(raw).updatedAt,
			persisted.stamp.updatedAt,
			'the stamp the caller adopts is the one written to the file',
		)
		assert.equal(raw.includes('"oldFile"'), false)
		assert.equal(raw.includes('"newFile"'), false)
		assert.equal(raw.includes('"contents"'), false)
		const parsed: ReviewState = JSON.parse(raw)
		assert.equal('oldFile' in parsed.files[0], false)
		assert.equal('newFile' in parsed.files[0], false)
		assert.equal(parsed.files[0].contentHash, 'H') // the OID key stays
	} finally {
		process.env.HOME = oldHome
		await fs.rm(home, { recursive: true, force: true })
	}
})
