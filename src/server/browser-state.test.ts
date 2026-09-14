import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { startServer } from '../server.js'

import type {
	BrowserRefreshEvent,
	BrowserReviewState,
	PollPayload,
	ReviewState,
} from '../types.js'

type StateResponse = BrowserReviewState & { serverInstanceId: string }

async function readJson<T>(response: Response): Promise<T> {
	return JSON.parse(await response.text())
}

const DIFF_SENTINEL = 'SERVER_ONLY_DIFF'.repeat(10_000)
const LINE_SENTINEL = 'SERVER_ONLY_LINE'.repeat(10_000)

function review(root: string): ReviewState {
	return {
		id: 'backend-id',
		session: 'wire',
		root,
		repoHash: 'backend-hash',
		mode: 'repo',
		staged: false,
		head: null,
		baseDiffHash: 'diff-hash',
		createdAt: 't',
		rawDiff: DIFF_SENTINEL,
		files: [
			{
				path: 'a.ts',
				oldPath: 'a.ts',
				newPath: 'a.ts',
				contentHash: 'file-hash',
				changeKind: 'modified',
				added: 1,
				removed: 0,
				size: 0,
				renamePure: false,
				hunks: [
					{
						header: '@@ -0,0 +1 @@',
						oldStart: 0,
						oldCount: 0,
						newStart: 1,
						newCount: 1,
						lines: [
							{
								kind: 'add',
								text: LINE_SENTINEL,
								newLine: 1,
								diffPosition: 1,
								hunkHeader: '@@ -0,0 +1 @@',
							},
						],
					},
				],
			},
		],
		comments: [],
		changes: [],
		reviewedFiles: [],
		stagedFiles: [],
	}
}

async function withDesk(
	run: (url: string, state: ReviewState) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), 'galley-wire-'))
	execFileSync('git', ['init', '-q'], { cwd: root })
	execFileSync(
		'git',
		[
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@test',
			'commit',
			'--allow-empty',
			'-qm',
			'base',
		],
		{ cwd: root },
	)
	const home = process.env.HOME
	process.env.HOME = root
	const state = review(root)
	Object.assign(state, { futureBackendField: 'not public' })
	Object.assign(state.files[0], { futureFileField: 'not public' })
	const desk = await startServer({ state, open: false, idleTimeoutMs: 0 })
	try {
		await run(desk.url, state)
	} finally {
		desk.server.close()
		process.env.HOME = home
		await rm(root, { recursive: true, force: true })
	}
}

function assertSlim(payload: BrowserReviewState): void {
	for (const key of [
		'rawDiff',
		'id',
		'repoHash',
		'head',
		'base',
		'createdAt',
		'updatedAt',
		'persistFile',
		'futureBackendField',
	])
		assert.equal(key in payload, false, `${key} stays on the backend`)
	const { files } = payload
	assert.equal(files.length, 1)
	assert.deepEqual(files[0], {
		path: 'a.ts',
		oldPath: 'a.ts',
		newPath: 'a.ts',
		contentHash: 'file-hash',
		changeKind: 'modified',
		added: 1,
		removed: 0,
		size: 0,
		renamePure: false,
		hasHunks: true,
	})
	assert.equal(payload.baseDiffHash, 'diff-hash')
	assert.equal(payload.staged, false)
	assert.deepEqual(payload.comments, [])
	assert.deepEqual(payload.changes, [])
}

void test('GET /api/state allowlists browser fields without stripping the backend diff', async () => {
	await withDesk(async (url, state) => {
		const response = await fetch(`${url}api/state`)
		assert.equal(response.status, 200)
		const text = await response.text()
		assertSlim(JSON.parse(text))
		assert.equal(text.includes(DIFF_SENTINEL), false)
		assert.equal(text.includes(LINE_SENTINEL), false)
		assert.ok(isDeepStrictEqual(state.rawDiff, DIFF_SENTINEL))
		assert.ok(
			isDeepStrictEqual(
				state.files[0].hunks[0].lines[0].text,
				LINE_SENTINEL,
			),
		)
	})
})

void test('POST /api/reset returns the same slim state and retains the backend diff', async () => {
	await withDesk(async (url, state) => {
		const response = await fetch(`${url}api/reset`, { method: 'POST' })
		assert.equal(response.status, 200)
		const payload = await readJson<{
			ok: boolean
			state: BrowserReviewState
			serverInstanceId: string
		}>(response)
		assert.equal(payload.ok, true)
		const initial = await readJson<StateResponse>(
			await fetch(`${url}api/state`),
		)
		assert.ok(
			isDeepStrictEqual(
				payload.serverInstanceId,
				initial.serverInstanceId,
			),
		)
		assert.equal('serverInstanceId' in state, false)
		assertSlim(payload.state)
		assert.ok(isDeepStrictEqual(state.rawDiff, DIFF_SENTINEL))
		assert.ok(
			isDeepStrictEqual(
				state.files[0].hunks[0].lines[0].text,
				LINE_SENTINEL,
			),
		)
	})
})

void test('hunkless files and an empty reload remain representable without diff bodies', async () => {
	await withDesk(async (url, state) => {
		Object.assign(state.files[0], { hunks: [], added: 0 })
		const response = await fetch(`${url}api/state`)
		const payload = await readJson<StateResponse>(response)
		assert.equal(payload.files[0].hasHunks, false)
		assert.equal(payload.files[0].added, 0)
		assert.equal(payload.files[0].removed, 0)
		const reload = await fetch(`${url}api/reload`, {
			method: 'POST',
			body: '{}',
		})
		assert.equal(reload.status, 200)
		const empty = await readJson<StateResponse>(
			await fetch(`${url}api/state`),
		)
		assert.deepEqual(empty.files, [])
		assert.equal(empty.baseDiffHash, 'e3b0c44298fc1c14')
	})
})

void test('a tab from a previous server receives a refresh event instead of review state', async () => {
	await withDesk(async url => {
		const response = await fetch(`${url}api/state`)
		const payload = await readJson<StateResponse>(response)
		assert.equal(typeof payload.serverInstanceId, 'string')
		const current = await fetch(
			`${url}api/poll?instance=${payload.serverInstanceId}`,
		)
		assert.equal(
			(await readJson<PollPayload>(current)).baseDiffHash,
			'diff-hash',
		)
		const stale = await fetch(`${url}api/poll?instance=previous-server`)
		const event = await readJson<BrowserRefreshEvent>(stale)
		assert.equal(event.kind, 'refresh')
		assert.equal('files' in event, false)
		assert.equal('baseDiffHash' in event, false)
		const legacy = await fetch(`${url}api/poll`)
		assert.equal(
			(await readJson<PollPayload>(legacy)).baseDiffHash,
			'diff-hash',
		)
	})
})
