import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { startServer } from './server.js'
import { buildReviewState } from './state/build.js'
import { writeGlobalSettings } from './state/desk.js'
import { hash } from './state/identity.js'

import type { AwaitEvent } from './types.js'
import type { BrowserReviewState, ReviewState } from './types.js'

function state(root: string): ReviewState {
	return {
		id: 'id',
		session: 's',
		root,
		repoHash: 'h',
		mode: 'repo',
		staged: false,
		head: null,
		baseDiffHash: 'base',
		createdAt: 't',
		rawDiff: '',
		files: [
			{
				path: 'a.ts',
				hunks: [],
				contentHash: 'H',
				changeKind: 'added',
				added: 1,
				removed: 0,
			},
		],
		comments: [],
		changes: [],
		reviewedFiles: [],
		stagedFiles: [],
	}
}

type ServerSeams = {
	runEditorCommand?: (command: string, args: string[]) => Promise<void>
	statusTtlMs?: number
	idleTimeoutMs?: number
	onShutdown?: (reason: 'idle' | 'stop') => void
	host?: string
	allowedHosts?: string[]
	// Fields seeded onto the live state before the desk starts, for tests that need recognisable
	// state (e.g. a rawDiff the routes must leave alone).
	seed?: Partial<ReviewState>
}

// Each test points HOME at a temp dir so the global ~/.galley/settings.json the
// open-editor handler reads is isolated from the developer's real one.
async function withServer(
	run: (
		handle: Awaited<ReturnType<typeof startServer>>,
		root: string,
		st: ReviewState,
	) => Promise<void>,
	options: ServerSeams = {},
): Promise<void> {
	const { seed, ...serverOptions } = options
	const root = await mkdtemp(path.join(tmpdir(), 'galley-server-'))
	const oldHome = process.env.HOME
	process.env.HOME = root
	const st = state(root)
	if (seed) Object.assign(st, seed)
	const handle = await startServer({
		state: st,
		open: false,
		...serverOptions,
	})
	try {
		await run(handle, root, st)
	} finally {
		handle.server.close()
		process.env.HOME = oldHome
		await rm(root, { recursive: true, force: true })
	}
}

void test('open-editor rejects paths outside the repo', async () => {
	await withServer(async handle => {
		const res = await fetch(`${handle.url}api/open-editor`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: '../x.ts', lineNumber: 2 }),
		})
		const body = await readJson<{ code?: string }>(res)
		assert.equal(res.status, 400)
		assert.equal(body.code, 'BAD_PATH')
	})
})

void test('open-editor rejects absolute paths', async () => {
	await withServer(async (handle, root) => {
		const res = await fetch(`${handle.url}api/open-editor`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				path: path.join(root, 'a.ts'),
				lineNumber: 2,
			}),
		})
		const body = await readJson<{ code?: string }>(res)
		assert.equal(res.status, 400)
		assert.equal(body.code, 'BAD_PATH')
	})
})

void test('open-editor rejects a non-allowlisted editor command', async () => {
	await withServer(async handle => {
		await writeGlobalSettings({
			settings: { editorCommand: 'node {file}' },
		})
		const res = await fetch(`${handle.url}api/open-editor`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: 'a.ts', lineNumber: 2 }),
		})
		const body = await readJson<{ code?: string }>(res)
		assert.equal(res.status, 422)
		assert.equal(body.code, 'EDITOR_NOT_ALLOWED')
	})
})

void test('open-editor rejects an object-valued preference without launching an application', async () => {
	let launchCount = 0
	await withServer(
		async (handle, root) => {
			await writeFile(path.join(root, 'a.ts'), 'hello\n', 'utf8')
			await writeGlobalSettings({
				settings: { editorCommand: { command: 'code' } },
			})
			const response = await post(handle.url, 'api/open-editor', {
				path: 'a.ts',
				lineNumber: 2,
			})
			assert.equal(response.status, 422)
			assert.ok(Object.is(launchCount, 0))
			const body: unknown = await response.json()
			assert.ok(
				typeof body === 'object' && body !== null && 'code' in body,
			)
			assert.equal(body.code, 'EDITOR_NOT_ALLOWED')
		},
		{
			runEditorCommand: async () => {
				launchCount += 1
			},
		},
	)
})

void test('open-editor runs the editor command from global settings', async () => {
	const calls: Array<{ command: string; args: string[] }> = []
	await withServer(
		async (handle, root) => {
			await writeFile(path.join(root, 'a.ts'), 'hello\n', 'utf8')
			await writeGlobalSettings({
				settings: { editorCommand: 'code -g {file}:{line}' },
			})
			const res = await fetch(`${handle.url}api/open-editor`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: 'a.ts', lineNumber: 9 }),
			})
			const body = await readJson<{ ok?: boolean }>(res)
			assert.equal(body.ok, true)
			assert.equal(calls[0].command, 'code')
			assert.ok(
				isDeepStrictEqual(calls[0].args, [
					'-g',
					`${path.join(root, 'a.ts')}:9`,
				]),
			)
		},
		{
			runEditorCommand: async (command, args) => {
				calls.push({ command, args })
			},
		},
	)
})

void test('the static routes serve the page and the bundle, and answer the favicon', async () => {
	await withServer(async handle => {
		// The desk resolves its assets relative to the compiled server (dist/) with a source-checkout
		// fallback, so a wrong root would 500 here rather than serve the checked-in page.
		const page = await fetch(handle.url)
		assert.equal(page.status, 200)
		assert.equal(
			page.headers.get('content-type'),
			'text/html; charset=utf-8',
		)
		assert.ok(
			Object.is(
				await page.text(),
				await readFile(
					path.join(process.cwd(), 'src', 'ui', 'index.html'),
					'utf8',
				),
			),
		)
		await assertUiBundle(handle.url)
		const favicon = await fetch(`${handle.url}favicon.ico`)
		assert.equal(favicon.status, 204)
	})
})

async function assertUiBundle(deskUrl: string): Promise<void> {
	const bundle = await fetch(`${deskUrl}ui.js`)
	const built = await readFile(
		new URL('../dist/ui.js', import.meta.url),
		'utf8',
	).catch(() => undefined)
	// Tests can run before a UI build. Missing assets must be a 404, not a successful
	// empty module that leaves the browser silently blank.
	if (!built) {
		assert.equal(bundle.status, 404)
		return
	}
	assert.equal(bundle.status, 200)
	assert.equal(
		bundle.headers.get('content-type'),
		'text/javascript; charset=utf-8',
	)
	assert.ok((await bundle.text()) === built)
	const etag = bundle.headers.get('etag')
	assert.ok(etag)
	const revalidated = await fetch(`${deskUrl}ui.js`, {
		headers: { 'if-none-match': etag },
	})
	assert.equal(revalidated.status, 304)
}

type StatePayload = BrowserReviewState & {
	agentActivity: { body: string; at: string } | null
	agentListening: boolean
	queuedQuestions: number
	queuedReviews: number
}

// Tests read the desk's JSON responses over HTTP, the same unchecked wire boundary
// state/persistence.ts documents for a review file: parse the body, take the declared type, and
// let the assertions below be the check. Node's fetch types `Response.json()` as `unknown`, which
// would otherwise force a hand-written validator per payload without adding coverage.
async function readJson<T>(res: Response): Promise<T> {
	return JSON.parse(await res.text())
}

async function getState(url: string): Promise<StatePayload> {
	const res = await fetch(`${url}api/state`)
	return await readJson<StatePayload>(res)
}

function post(url: string, pathname: string, body: unknown): Promise<Response> {
	return fetch(`${url}${pathname}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
}

void test('status posts ephemeral agent activity into the state payload', async () => {
	await withServer(async handle => {
		const res = await post(handle.url, 'api/status', {
			body: 'Reading a.ts…',
		})
		assert.equal(res.status, 200)
		const st = await getState(handle.url)
		assert.equal(st.agentActivity?.body, 'Reading a.ts…')
		assert.equal(st.agentListening, false)
		assert.equal(st.queuedQuestions, 0)
		assert.equal(st.queuedReviews, 0)
	})
})

void test('status rejects an empty body', async () => {
	await withServer(async handle => {
		const res = await post(handle.url, 'api/status', { body: '  ' })
		const body = await readJson<{ code?: string }>(res)
		assert.equal(res.status, 422)
		assert.equal(body.code, 'INVALID_STATUS')
	})
})

void test('an agent comment clears the activity line', async () => {
	await withServer(async handle => {
		await post(handle.url, 'api/status', { body: 'Running tests…' })
		await post(handle.url, 'api/comment', {
			path: 'a.ts',
			lineNumber: 1,
			body: 'Done - answer.',
		})
		const st = await getState(handle.url)
		assert.equal(st.agentActivity, null)
	})
})

void test('activity goes stale past the TTL (checked on read, no timers)', async () => {
	await withServer(
		async handle => {
			await post(handle.url, 'api/status', { body: 'Reading…' })
			const st = await getState(handle.url)
			assert.equal(st.agentActivity, null)
		},
		{ statusTtlMs: 0 },
	)
})

void test('/api/poll ships the lite slice plus desk status - never the heavy state', async () => {
	await withServer(
		async (handle, _root, st) => {
			await post(handle.url, 'api/status', { body: 'Working…' })
			await post(handle.url, 'api/comment', {
				path: 'a.ts',
				lineNumber: 1,
				body: 'a reply',
			})
			const pollRes = await fetch(`${handle.url}api/poll`)
			const poll = await readJson<Record<string, unknown>>(pollRes)
			// Everything pollState diffs per tick…
			assert.equal(poll.baseDiffHash, st.baseDiffHash)
			const { comments } = poll
			assert.ok(Array.isArray(comments), 'comments ride the poll')
			assert.equal(comments.length, 1)
			assert.equal(typeof poll.agentListening, 'boolean')
			assert.equal(poll.queuedQuestions, 0)
			// …and none of the payload that made polling the full state melt big desks.
			assert.ok(!('rawDiff' in poll), 'rawDiff must not ride the poll')
			assert.ok(
				!('files' in poll),
				'file contents must not ride the poll',
			)
			assert.ok(!('changes' in poll), 'changes must not ride the poll')
		},
		{ seed: { rawDiff: 'HEAVY DIFF THAT MUST NOT RIDE THE POLL' } },
	)
})

void test('an unconsumed question surfaces as queuedQuestions', async () => {
	await withServer(async handle => {
		await post(handle.url, 'api/ask', {
			path: 'a.ts',
			lineNumber: 1,
			body: 'why?',
		})
		const st = await getState(handle.url)
		assert.equal(st.queuedQuestions, 1)
		assert.equal(st.agentListening, false)
	})
})

void test('multiple questions asked before an await batch into one event, oldest first', async () => {
	await withServer(async handle => {
		await post(handle.url, 'api/ask', {
			path: 'a.ts',
			lineNumber: 1,
			body: 'first?',
		})
		await post(handle.url, 'api/ask', {
			path: 'a.ts',
			lineNumber: 2,
			body: 'second?',
		})
		const eventRes = await fetch(`${handle.url}api/await-send`)
		const event = await readJson<AwaitEvent>(eventRes)
		if (event.kind !== 'question')
			assert.fail('await-send handed back a question event')
		assert.equal(event.questions.length, 2)
		assert.ok(
			isDeepStrictEqual(
				event.questions.map(question => question.body),
				['first?', 'second?'],
			),
		)
		assert.ok(isDeepStrictEqual(event.question, event.questions[0])) // singular is the oldest
		// Both drained - nothing left queued for the UI's waiting indicator.
		const st = await getState(handle.url)
		assert.equal(st.queuedQuestions, 0)
	})
})

void test('Send flushes queued questions and folds the unanswered ones into openQuestions', async () => {
	await withServer(async (handle, _root, st) => {
		// Two open question comments the reviewer left (the source for openQuestions), plus the
		// matching live question events (the source for the queue) - two independent representations.
		st.comments.push(
			{
				id: 'q1',
				path: 'a.ts',
				side: 'additions',
				lineNumber: 1,
				body: 'why q1?',
				createdAt: '2026-01-01T00:00:00Z',
				updatedAt: '2026-01-01T00:00:00Z',
				status: 'open',
				intent: 'question',
				role: 'user',
			},
			{
				id: 'q2',
				path: 'a.ts',
				side: 'additions',
				lineNumber: 2,
				body: 'why q2?',
				createdAt: '2026-01-01T00:00:01Z',
				updatedAt: '2026-01-01T00:00:01Z',
				status: 'open',
				intent: 'question',
				role: 'user',
			},
		)
		await post(handle.url, 'api/ask', {
			path: 'a.ts',
			lineNumber: 1,
			body: 'why q1?',
		})
		await post(handle.url, 'api/ask', {
			path: 'a.ts',
			lineNumber: 2,
			body: 'why q2?',
		})

		const sentRes = await post(
			handle.url,
			'api/send',
			await getState(handle.url),
		)
		const sent = await readJson<{ sent?: boolean }>(sentRes)
		assert.equal(sent.sent, true)

		// The review is emitted on the send response's 'finish'; poll until it lands. The queued
		// questions are flushed in the same step, so queuedQuestions must be 0 by then.
		const status = await waitForQueuedReview(handle.url, POLL_ATTEMPTS)
		assert.equal(status.queuedReviews, 1)
		assert.equal(status.queuedQuestions, 0) // superseded questions flushed

		// Next await is the review (not a stale question), carrying both unanswered questions.
		const reviewRes = await fetch(`${handle.url}api/await-send`)
		const review = await readJson<AwaitEvent>(reviewRes)
		if (review.kind !== 'review')
			assert.fail(
				'await-send handed back the review once the round landed',
			)
		assert.deepEqual(
			review.result.openQuestions
				.map(question => question.body)
				.toSorted(),
			['why q1?', 'why q2?'],
		)

		// Nothing dribbles in after the round: a bounded await times out (204).
		const after = await fetch(`${handle.url}api/await-send?timeout=1`)
		assert.equal(after.status, 204)
	})
})

void test('send survives bodies beyond the old 5 MB cap and merges only the reviewer slice', async () => {
	await withServer(async (handle, _root, st) => {
		// Regression: pre-0.6.2 tabs post the entire ReviewState on Send, and a big PR desk
		// crosses 5 MB - readBody threw before the result was built, so no artifact and no
		// event ("Could not send review") while the slice-only auto-saves kept succeeding.
		const res = await post(handle.url, 'api/send', {
			...(await getState(handle.url)),
			rawDiff: 'x'.repeat(6_000_000), // push the body well past the old cap
			reviewedFiles: ['a.ts'],
			overallNote: 'ship it',
		})
		const sent = await readJson<{ sent?: boolean; resultJson?: string }>(
			res,
		)
		assert.equal(sent.sent, true)
		// Only the reviewer-owned slice merges; server-authoritative fields stay untouched.
		assert.ok(isDeepStrictEqual(st.reviewedFiles, ['a.ts']))
		assert.equal(st.rawDiff, '')
		// overallNote rides into the result but never onto the persisted state.
		assert.ok(sent.resultJson, 'send wrote its result artifact')
		const rawResult = await readFile(sent.resultJson, 'utf8')
		const sentResult: { overallNote?: string } = JSON.parse(rawResult)
		assert.equal(sentResult.overallNote, 'ship it')
		assert.equal('overallNote' in st, false)
	})
})

void test('save strips transient desk-status keys so they never persist on state', async () => {
	await withServer(async (handle, _root, st) => {
		const payload = await getState(handle.url)
		// The UI posts its copy of the /api/state payload back - transient keys ride along.
		await post(handle.url, 'api/save', {
			...payload,
			agentActivity: { body: 'leak', at: 't' },
			queuedQuestions: 9,
		})
		assert.equal('agentActivity' in st, false)
		assert.equal('agentListening' in st, false)
		assert.equal('queuedQuestions' in st, false)
		assert.equal('queuedReviews' in st, false)
	})
})

void test('save merges the reviewer-owned slice and leaves server-owned state authoritative', async () => {
	await withServer(
		async (handle, _root, st) => {
			// The real slim wire: only reviewer-owned fields, no rawDiff and no file contents.
			const res = await post(handle.url, 'api/save', {
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
				comments: [],
				reviewedFiles: ['a.ts'],
				reviewedFileHashes: { 'a.ts': 'H' },
				decisionFiles: ['a.ts'],
			})
			assert.equal(res.status, 200)
			assert.ok(isDeepStrictEqual(st.reviewedFiles, ['a.ts']))
			assert.deepEqual(st.decisionFiles, ['a.ts'])
			assert.equal(st.decisions?.[0]?.status, 'accepted')
			// Server-owned fields are untouched - the wire never carried them.
			assert.equal(st.rawDiff, 'SERVER DIFF')
			assert.equal(st.files.length, 1)
			assert.equal(st.files[0].contentHash, 'H')
		},
		{ seed: { rawDiff: 'SERVER DIFF' } },
	)
})

void test('save from a stale full-state tab ignores server-owned fields in the body', async () => {
	await withServer(async (handle, _root, st) => {
		const before = st.files[0].contentHash
		// A stale tab POSTs the whole old ReviewState (old shape, contents and all) - the server must
		// pick only the reviewer slice and leave its own files untouched.
		await post(handle.url, 'api/save', {
			reviewedFiles: ['a.ts'],
			rawDiff: 'CLIENT DIFF SHOULD BE IGNORED',
			baseDiffHash: 'client-hash',
			files: [
				{
					path: 'evil.ts',
					hunks: [],
					oldFile: { contents: '' },
					newFile: { contents: 'x' },
					contentHash: 'E',
				},
			],
			id: 'spoofed',
		})
		assert.ok(isDeepStrictEqual(st.reviewedFiles, ['a.ts']))
		assert.equal(st.rawDiff, '')
		assert.equal(st.baseDiffHash, 'base')
		assert.equal(st.id, 'id')
		assert.equal(st.files.length, 1)
		assert.ok(Object.is(st.files[0].contentHash, before))
	})
})

void test('/api/stage: paths[] stages a move pair as a rename; legacy {path} still works (issue 02)', async () => {
	await withServer(async (handle, root, st) => {
		const g = (args: string[]): string =>
			execFileSync('git', args, { cwd: root }).toString()
		g(['init', '-q'])
		g(['config', 'user.email', 't@t.co'])
		g(['config', 'user.name', 'tester'])
		await writeFile(path.join(root, 'old.ts'), 'x\n')
		g(['add', '.'])
		g(['commit', '-qm', 'init'])
		// Plain mv: old.ts deleted in the worktree (still in HEAD), new.ts untracked. Plus an
		// unrelated untracked file to exercise the legacy single-path body.
		await rm(path.join(root, 'old.ts'))
		await writeFile(path.join(root, 'new.ts'), 'x\n')
		await writeFile(path.join(root, 'extra.ts'), 'y\n')
		const postStage = (body: unknown): Promise<Response> =>
			fetch(`${handle.url}api/stage`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			})
		assert.equal((await postStage({ path: 'extra.ts' })).status, 200) // legacy single-path
		assert.equal(
			(await postStage({ paths: ['old.ts', 'new.ts'] })).status,
			200,
		) // move pair
		const porcelain = g(['status', '--porcelain'])
		assert.match(porcelain, /R\s+old\.ts -> new\.ts/) // a staged rename, not add + delete
		assert.match(porcelain, /A\s+extra\.ts/)
		// stagedFiles records the review path once: the new path for the pair, plus the legacy file.
		assert.ok(st.stagedFiles.includes('new.ts'))
		assert.ok(st.stagedFiles.includes('extra.ts'))
		assert.ok(!st.stagedFiles.includes('old.ts'))
	})
})

void test('/api/reload: a guide-declared move merges into a rename entry; a bad one is 422, desk untouched (issue 03)', async () => {
	await withServer(async (handle, root, st) => {
		const g = (args: string[]): string =>
			execFileSync('git', args, { cwd: root }).toString()
		g(['init', '-q'])
		g(['config', 'user.email', 't@t.co'])
		g(['config', 'user.name', 'tester'])
		await writeFile(path.join(root, 'a.ts'), 'l1\nl2\nl3\n')
		g(['add', '.'])
		g(['commit', '-qm', 'init'])
		// Plain mv + edit: a.ts deleted in the worktree, b.ts untracked with one changed line.
		await rm(path.join(root, 'a.ts'))
		await writeFile(path.join(root, 'b.ts'), 'l1\nCHANGED\nl3\n')
		const reload = (guide: unknown): Promise<Response> =>
			fetch(`${handle.url}api/reload`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ guide }),
			})
		// Declared move resolves → one rename-changed entry at b.ts, a.ts gone.
		const ok = await reload({
			overview: 'o',
			files: [
				{
					path: 'b.ts',
					orientation: 'moved and edited',
					movedFrom: 'a.ts',
				},
			],
		})
		assert.equal(ok.status, 200)
		assert.ok(st.files.some(f => f.path === 'b.ts' && f.oldPath === 'a.ts'))
		assert.ok(!st.files.some(f => f.path === 'a.ts'))
		// A movedFrom naming a file that isn't a deletion → 422, and the live desk is left as it was.
		const before = st.files.map(f => f.path).toSorted()
		const bad = await reload({
			overview: 'o',
			files: [{ path: 'b.ts', orientation: 'x', movedFrom: 'ghost.ts' }],
		})
		assert.equal(bad.status, 422)
		assert.ok(
			isDeepStrictEqual(st.files.map(f => f.path).toSorted(), before),
		)
	})
})

void test('/api/file-contents returns contents equal to the embedded copies; rejects escapes + unknown paths (issue 02)', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'galley-fc-'))
	const oldHome = process.env.HOME
	process.env.HOME = root
	const g = (args: string[]): string =>
		execFileSync('git', args, { cwd: root }).toString()
	g(['init', '-q'])
	g(['config', 'user.email', 't@t.co'])
	g(['config', 'user.name', 'tester'])
	await writeFile(path.join(root, 'a.ts'), 'one\ntwo\nthree\n')
	g(['add', '.'])
	g(['commit', '-qm', 'init'])
	// Working-tree change: a.ts modified (a real diff), plus b.ts brand-new (untracked → old = "").
	await writeFile(path.join(root, 'a.ts'), 'one\nCHANGED\nthree\n')
	await writeFile(path.join(root, 'b.ts'), 'brand new\n')
	const st = await buildReviewState(root, { session: 's' })
	assert.ok(st, 'built a review state for the working diff')
	const handle = await startServer({
		state: st,
		open: false,
		idleTimeoutMs: 0,
	})
	try {
		// The state embeds no contents - the resolver reads git (old = committed) / the working tree
		// (new). Assert the exact bytes, plus the OIDs the payload now carries (newOid = the file key).
		const cases = [
			{
				rel: 'a.ts',
				old: 'one\ntwo\nthree\n',
				new: 'one\nCHANGED\nthree\n',
			},
			{ rel: 'b.ts', old: '', new: 'brand new\n' }, // untracked → no old side
		]
		await Promise.all(
			cases.map(async side => {
				const file = st.files.find(
					candidate => candidate.path === side.rel,
				)
				assert.ok(file, `${side.rel} is part of the review`)
				const res = await fetch(
					`${handle.url}api/file-contents?path=${side.rel}`,
				)
				const payload = await readJson<{
					path: string
					oldContents: string
					newContents: string
					oldOid: string
					newOid: string
				}>(res)
				assert.ok(
					Object.is(payload.oldContents, side.old),
					`${side.rel} old side resolves from git`,
				)
				assert.ok(
					Object.is(payload.newContents, side.new),
					`${side.rel} new side resolves from the working tree`,
				)
				assert.ok(
					Object.is(payload.newOid, file.contentHash),
					`${side.rel} newOid is the file-level key`,
				)
				assert.match(
					payload.oldOid,
					/^[0-9a-f]{40}$/,
					`${side.rel} oldOid is a blob OID`,
				)
			}),
		)
		// Path escape → 400 BAD_PATH (same boundary as /api/file).
		const escape = await fetch(
			`${handle.url}api/file-contents?path=${encodeURIComponent('../x.ts')}`,
		)
		assert.equal(escape.status, 400)
		const escapeBody = await readJson<{ code?: string }>(escape)
		assert.equal(escapeBody.code, 'BAD_PATH')
		// A path not in the review → 404 NOT_FOUND.
		const missing = await fetch(
			`${handle.url}api/file-contents?path=nope.ts`,
		)
		assert.equal(missing.status, 404)
		const missingBody = await readJson<{ code?: string }>(missing)
		assert.equal(missingBody.code, 'NOT_FOUND')
	} finally {
		handle.server.close()
		process.env.HOME = oldHome
		await rm(root, { recursive: true, force: true })
	}
})

void test(
	'/api/file refuses a path that resolves outside the repo via an in-repo symlink (issue 03)',
	// symlink creation is privileged on win32; skip there.
	{ skip: process.platform === 'win32' },
	async () => {
		await withServer(async (handle, root) => {
			// A secret file outside the repo, plus an in-repo symlink that points at it. The
			// unresolved prefix check passes (leak.txt sits under root) but the resolved target
			// escapes - the route must realpath and refuse to follow the link.
			const outside = await mkdtemp(
				path.join(tmpdir(), 'galley-outside-'),
			)
			const secret = path.join(outside, 'secret.txt')
			await writeFile(secret, 'TOP SECRET\n')
			await symlink(secret, path.join(root, 'leak.txt'))
			try {
				const leak = await fetch(`${handle.url}api/file?path=leak.txt`)
				assert.notEqual(
					leak.status,
					200,
					'an escaping symlink is never served',
				)
				const leakBody = await readJson<{ code?: string }>(leak)
				assert.equal(leakBody.code, 'BAD_PATH')

				// A plain in-repo file is served unchanged.
				await writeFile(path.join(root, 'ok.txt'), 'fine\n')
				const ok = await fetch(`${handle.url}api/file?path=ok.txt`)
				assert.equal(ok.status, 200)
				const okBody = await readJson<{ contents?: string }>(ok)
				assert.equal(okBody.contents, 'fine\n')

				// A symlink that still resolves INSIDE the repo keeps working.
				await symlink(
					path.join(root, 'ok.txt'),
					path.join(root, 'alias.txt'),
				)
				const alias = await fetch(
					`${handle.url}api/file?path=alias.txt`,
				)
				assert.equal(alias.status, 200)
				const aliasBody = await readJson<{ contents?: string }>(alias)
				assert.equal(aliasBody.contents, 'fine\n')
			} finally {
				await rm(outside, { recursive: true, force: true })
			}
		})
	},
)

void test('/api/state carries no file contents (lean wire, issue 04)', async () => {
	await withServer(async handle => {
		const res = await fetch(`${handle.url}api/state`)
		const payload = await readJson<{
			files: Array<Record<string, unknown>>
		}>(res)
		assert.ok(payload.files.length >= 1)
		for (const file of payload.files) {
			assert.equal('oldFile' in file, false)
			assert.equal('newFile' in file, false)
		}
		assert.equal(
			JSON.stringify(payload.files).includes('"contents"'),
			false,
		)
	})
})

void test('POST /api/comment anchors a file the tab never opened (issue 04)', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'galley-anchor-'))
	const oldHome = process.env.HOME
	process.env.HOME = root
	const g = (args: string[]): string =>
		execFileSync('git', args, { cwd: root }).toString()
	g(['init', '-q'])
	g(['config', 'user.email', 't@t.co'])
	g(['config', 'user.name', 'tester'])
	await writeFile(path.join(root, 'a.ts'), 'one\ntwo\nthree\n')
	g(['add', '.'])
	g(['commit', '-qm', 'init'])
	await writeFile(path.join(root, 'a.ts'), 'one\nCHANGED\nthree\n')
	const st = await buildReviewState(root, { session: 's' })
	assert.ok(st)
	const handle = await startServer({
		state: st,
		open: false,
		idleTimeoutMs: 0,
	})
	try {
		// Anchoring fetches the file's contents on demand (the state embeds none), so it works even
		// though no tab ever opened a.ts. New-side line 2 is "CHANGED".
		const res = await fetch(`${handle.url}api/comment`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				path: 'a.ts',
				side: 'additions',
				lineNumber: 2,
				body: 'why?',
				role: 'user',
			}),
		})
		assert.equal(res.status, 200)
		const stateRes = await fetch(`${handle.url}api/state`)
		const payload = await readJson<{
			comments: Array<{ path: string; anchorText?: string }>
		}>(stateRes)
		const comment = payload.comments.find(x => x.path === 'a.ts')
		assert.ok(comment, 'comment persisted')
		assert.equal(comment.anchorText, 'CHANGED')
	} finally {
		handle.server.close()
		process.env.HOME = oldHome
		await rm(root, { recursive: true, force: true })
	}
})

const sleep = (ms: number): Promise<void> =>
	new Promise(resolve => setTimeout(resolve, ms))

const POLL_ATTEMPTS = 100
const POLL_INTERVAL_MS = 10

// Poll until the desk reports a queued review. Each read depends on the previous one, so this
// recurses rather than awaiting inside a loop.
async function waitForQueuedReview(
	url: string,
	attemptsLeft: number,
): Promise<StatePayload> {
	const snapshot = await getState(url)
	if (snapshot.queuedReviews > 0 || attemptsLeft <= 0) return snapshot
	await sleep(POLL_INTERVAL_MS)
	return waitForQueuedReview(url, attemptsLeft - 1)
}

void test('POST /api/shutdown acks then triggers shutdown with reason stop', async () => {
	const reasons: string[] = []
	await withServer(
		async handle => {
			const res = await fetch(`${handle.url}api/shutdown`, {
				method: 'POST',
			})
			const body = await readJson<{ ok?: boolean; stopping?: boolean }>(
				res,
			)
			assert.equal(body.ok, true)
			assert.equal(body.stopping, true)
			// Shutdown fires on response finish - give the event loop a beat.
			await sleep(20)
			assert.ok(isDeepStrictEqual(reasons, ['stop']))
		},
		{ idleTimeoutMs: 0, onShutdown: reason => reasons.push(reason) },
	)
})

void test('idle timeout shuts the desk down when nothing is connected', async () => {
	const reasons: string[] = []
	await withServer(
		async () => {
			await sleep(200)
			assert.ok(isDeepStrictEqual(reasons, ['idle']))
		},
		{ idleTimeoutMs: 50, onShutdown: reason => reasons.push(reason) },
	)
})

void test('an in-flight await-send long-poll pins the desk past the idle timeout', async () => {
	const reasons: string[] = []
	await withServer(
		async handle => {
			// Holds the connection open well past idleTimeoutMs; activeRequests > 0 must
			// block the idle exit for as long as an agent is parked on await.
			const poll = fetch(`${handle.url}api/await-send?timeout=1`)
			await sleep(200)
			assert.deepEqual(
				reasons,
				[],
				'no idle shutdown while a long-poll is held',
			)
			const res = await poll
			assert.equal(res.status, 204) // bounded hold expired with no event
		},
		{ idleTimeoutMs: 50, onShutdown: reason => reasons.push(reason) },
	)
})

type RawResponse = {
	status: number
	headers: http.IncomingHttpHeaders
	body: string
}

// fetch (undici) silently drops the forbidden Host/Origin request headers, so the origin guard
// can only be exercised with a raw http.request that lets us set them verbatim.
function rawRequest(
	url: string,
	opts: {
		method?: string
		headers?: Record<string, string>
		body?: string
	} = {},
): Promise<RawResponse> {
	const u = new URL(url)
	return new Promise<RawResponse>((resolve, reject) => {
		const req = http.request(
			{
				hostname: u.hostname,
				port: u.port,
				path: u.pathname + u.search,
				method: opts.method ?? 'GET',
				headers: opts.headers,
			},
			res => {
				let rawBody = ''
				res.on('data', chunk => {
					rawBody += chunk
				})
				res.on('end', () => {
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: rawBody,
					})
				})
			},
		)
		req.on('error', reject)
		if (opts.body) req.write(opts.body)
		req.end()
	})
}

function readErrorCode(rawBody: string): string | undefined {
	const payload: { code?: string } = JSON.parse(rawBody)
	return payload.code
}

void test('origin guard rejects a foreign Host before any route runs', async () => {
	await withServer(async handle => {
		const res = await rawRequest(`${handle.url}api/state`, {
			headers: { host: 'evil.example' },
		})
		assert.equal(res.status, 403)
		assert.equal(readErrorCode(res.body), 'FORBIDDEN_HOST')
	})
})

void test('origin guard rejects a cross-site Origin on a mutating POST', async () => {
	await withServer(async handle => {
		const res = await rawRequest(`${handle.url}api/status`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'http://evil.example',
			},
			body: JSON.stringify({ body: 'Reading…' }),
		})
		assert.equal(res.status, 403)
		assert.equal(readErrorCode(res.body), 'FORBIDDEN_ORIGIN')
	})
})

void test('origin guard accepts a same-origin POST and a POST with no Origin', async () => {
	await withServer(async handle => {
		// Same-origin: the desk's own http://127.0.0.1:<port> Origin passes.
		const sameOrigin = await rawRequest(`${handle.url}api/status`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: new URL(handle.url).origin,
			},
			body: JSON.stringify({ body: 'Reading…' }),
		})
		assert.equal(sameOrigin.status, 200)
		// No Origin at all (curl / the CLI agent subcommands) is allowed - and no wildcard CORS leaks.
		const noOrigin = await rawRequest(`${handle.url}api/status`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ body: 'Working…' }),
		})
		assert.equal(noOrigin.status, 200)
		assert.equal(noOrigin.headers['access-control-allow-origin'], undefined)
	})
})

// Connect over loopback (portable on CI) but present an arbitrary Host header - the only way to
// exercise the origin guard, since undici drops a forbidden Host on fetch (see rawRequest).
function withHost(
	loopbackUrl: string,
	host: string,
	method = 'GET',
): Promise<RawResponse> {
	if (method === 'POST')
		return rawRequest(loopbackUrl, {
			method,
			headers: {
				host,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ body: 'x' }),
		})
	return rawRequest(loopbackUrl, { method, headers: { host } })
}

void test('default bind (loopback) still 403s the machine hostname - no widening', async () => {
	await withServer(async handle => {
		// handle.url is loopback by default; lockUrl equals it.
		assert.ok(Object.is(handle.lockUrl, handle.url))
		const { port } = new URL(handle.url)
		const res = await withHost(
			`${handle.url}api/state`,
			`${hostname()}:${port}`,
		)
		assert.equal(res.status, 403)
		assert.equal(readErrorCode(res.body), 'FORBIDDEN_HOST')
	})
})

void test('--host 0.0.0.0 accepts the hostname authority and loopback; lock stays loopback', async () => {
	await withServer(
		async handle => {
			// The browser URL advertises the hostname; the lock (agent-side) stays on 127.0.0.1.
			assert.match(handle.url, new RegExp(`^http://${hostname()}:\\d+/$`))
			assert.match(handle.lockUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/)
			const { port } = new URL(handle.lockUrl)
			// Reach the desk over loopback (the wildcard bind includes it) with the hostname in Host.
			const named = await withHost(
				`${handle.lockUrl}api/state`,
				`${hostname()}:${port}`,
			)
			assert.equal(named.status, 200)
			// Loopback authority still works.
			const loop = await withHost(
				`${handle.lockUrl}api/state`,
				`127.0.0.1:${port}`,
			)
			assert.equal(loop.status, 200)
			// A foreign Host is still refused - the guard is extended, not defeated.
			const evil = await withHost(
				`${handle.lockUrl}api/state`,
				`evil.example:${port}`,
			)
			assert.equal(evil.status, 403)
			assert.equal(readErrorCode(evil.body), 'FORBIDDEN_HOST')
		},
		{ host: '0.0.0.0', idleTimeoutMs: 0 },
	)
})

void test('GALLEY_ALLOWED_HOSTS entries pass the guard; a non-member 403s', async () => {
	await withServer(
		async handle => {
			const { port } = new URL(handle.lockUrl)
			const allowed = await withHost(
				`${handle.lockUrl}api/state`,
				`dev.tail1234.ts.net:${port}`,
			)
			assert.equal(allowed.status, 200)
			const other = await withHost(
				`${handle.lockUrl}api/state`,
				`nope.example:${port}`,
			)
			assert.equal(other.status, 403)
		},
		{
			host: '0.0.0.0',
			allowedHosts: ['dev.tail1234.ts.net'],
			idleTimeoutMs: 0,
		},
	)
})

const MUTEX_ROUNDS = 20

// Fire the two mutating routes concurrently, then re-read the desk. The queue's FIFO/non-poisoning
// contract is unit-tested in mutex.test.ts; here we assert the end-to-end invariant it exists to
// protect - that a reload's Object.assign never lands mid-save to stitch a half-applied snapshot.
// After every round the backend hash still matches its rawDiff, and the browser projection agrees.
// rawDiff stays backend-only; removing it from the wire must not weaken this concurrency invariant.
async function reloadAndSaveTogether(
	url: string,
	backendState: ReviewState,
	round: number,
): Promise<void> {
	const [reloadRes, saveRes] = await Promise.all([
		post(url, 'api/reload', {}),
		post(url, 'api/save', { reviewedFiles: ['a.ts'] }),
	])
	assert.equal(reloadRes.status, 200, `reload ${round} ok`)
	assert.equal(saveRes.status, 200, `save ${round} ok`)
	const snapshot = await getState(url)
	assert.ok(
		isDeepStrictEqual(
			backendState.baseDiffHash,
			hash(backendState.rawDiff),
		),
		`backend hash matches rawDiff (round ${round})`,
	)
	assert.ok(
		isDeepStrictEqual(snapshot.baseDiffHash, backendState.baseDiffHash),
		`browser hash matches backend (round ${round})`,
	)
}

async function runMutexRounds(
	url: string,
	backendState: ReviewState,
	round: number,
): Promise<void> {
	if (round > MUTEX_ROUNDS) return
	await reloadAndSaveTogether(url, backendState, round)
	return runMutexRounds(url, backendState, round + 1)
}

void test('concurrent /api/reload and /api/save leave the desk internally consistent (issue 05)', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'galley-mutex-'))
	const oldHome = process.env.HOME
	process.env.HOME = root
	const g = (args: string[]): string =>
		execFileSync('git', args, { cwd: root }).toString()
	g(['init', '-q'])
	g(['config', 'user.email', 't@t.co'])
	g(['config', 'user.name', 'tester'])
	await writeFile(path.join(root, 'a.ts'), 'one\ntwo\nthree\n')
	g(['add', '.'])
	g(['commit', '-qm', 'init'])
	// A real working-tree diff so /api/reload does its full (git-bound) rebuild each round.
	await writeFile(path.join(root, 'a.ts'), 'one\nCHANGED\nthree\n')
	const st = await buildReviewState(root, { session: 's' })
	assert.ok(st, 'built a review state for the working diff')
	const handle = await startServer({
		state: st,
		open: false,
		idleTimeoutMs: 0,
	})
	try {
		await runMutexRounds(handle.url, st, 1)
	} finally {
		handle.server.close()
		process.env.HOME = oldHome
		await rm(root, { recursive: true, force: true })
	}
})

void test('a throwing wrapped route settles the mutex without poisoning the chain (issue 05)', async () => {
	await withServer(async (handle, _root, st) => {
		// Invalid JSON reaches the serialized /api/save body, where JSON.parse throws - the wrapped
		// fn rejects. The chain must swallow that rejection (not wedge behind a permanently-rejected
		// promise) while the caller still sees the 500.
		const bad = await fetch(`${handle.url}api/save`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{ not valid json',
		})
		assert.equal(bad.status, 500)
		const badBody = await readJson<{ code?: string }>(bad)
		assert.equal(badBody.code, 'INTERNAL')
		// A following mutation still runs to completion - proof the queue kept flowing.
		const ok = await post(handle.url, 'api/save', {
			reviewedFiles: ['a.ts'],
		})
		assert.equal(ok.status, 200)
		assert.ok(isDeepStrictEqual(st.reviewedFiles, ['a.ts']))
	})
})

void test('/api/reset unstages every reviewed file in one batched restore and clears the review (issue 13)', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'galley-reset-'))
	const oldHome = process.env.HOME
	process.env.HOME = root
	const g = (args: string[]): string =>
		execFileSync('git', args, { cwd: root }).toString()
	g(['init', '-q'])
	g(['config', 'user.email', 't@t.co'])
	g(['config', 'user.name', 'tester'])
	await writeFile(path.join(root, 'a.ts'), 'one\n')
	await writeFile(path.join(root, 'b.ts'), 'two\n')
	g(['add', '.'])
	g(['commit', '-qm', 'init'])
	// Change both files and stage them, so the index carries two paths for the reset to restore.
	await writeFile(path.join(root, 'a.ts'), 'one CHANGED\n')
	await writeFile(path.join(root, 'b.ts'), 'two CHANGED\n')
	const st = await buildReviewState(root, { session: 's' })
	assert.ok(st, 'built a review state for the working diff')
	g(['add', '.'])
	assert.deepEqual(
		g(['diff', '--cached', '--name-only']).trim().split('\n').toSorted(),
		['a.ts', 'b.ts'],
		'both files staged before reset',
	)
	st.comments.push({
		id: 'c1',
		path: 'a.ts',
		side: 'additions',
		lineNumber: 1,
		body: 'x',
		createdAt: 't',
		updatedAt: 't',
		status: 'open',
		role: 'user',
	})
	st.decisions = [
		{
			key: 'a.ts:k',
			status: 'accepted',
			path: 'a.ts',
			lineNumber: 1,
			side: 'additions',
			title: 't',
		},
	]
	const handle = await startServer({
		state: st,
		open: false,
		idleTimeoutMs: 0,
	})
	try {
		const res = await fetch(`${handle.url}api/reset`, { method: 'POST' })
		assert.equal(res.status, 200)
		// A single batched `git restore --staged -- a.ts b.ts` cleared the index for BOTH files.
		assert.equal(
			g(['diff', '--cached', '--name-only']).trim(),
			'',
			'index restored for every file',
		)
		// …and the reviewer-owned slice is wiped.
		assert.deepEqual(st.comments, [])
		assert.deepEqual(st.decisions, [])
	} finally {
		handle.server.close()
		process.env.HOME = oldHome
		await rm(root, { recursive: true, force: true })
	}
})

void test('/api/reset in pr mode clears the review without touching the git index (issue 13)', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'galley-reset-pr-'))
	const oldHome = process.env.HOME
	process.env.HOME = root
	const g = (args: string[]): string =>
		execFileSync('git', args, { cwd: root }).toString()
	g(['init', '-q'])
	g(['config', 'user.email', 't@t.co'])
	g(['config', 'user.name', 'tester'])
	await writeFile(path.join(root, 'a.ts'), 'one\n')
	g(['add', '.'])
	g(['commit', '-qm', 'init'])
	// A staged change sitting in the index - if reset spawned git in pr mode, it would vanish.
	await writeFile(path.join(root, 'a.ts'), 'one CHANGED\n')
	g(['add', '.'])
	const st: ReviewState = {
		...state(root),
		mode: 'pr',
		comments: [
			{
				id: 'c1',
				path: 'a.ts',
				side: 'additions',
				lineNumber: 1,
				body: 'x',
				createdAt: 't',
				updatedAt: 't',
				status: 'open',
				role: 'user',
			},
		],
	}
	const handle = await startServer({
		state: st,
		open: false,
		idleTimeoutMs: 0,
	})
	try {
		const res = await fetch(`${handle.url}api/reset`, { method: 'POST' })
		assert.equal(res.status, 200)
		// PR mode has no working-tree index to restore - the staged change is left exactly as it was
		// (staging is disabled in pr mode), proving the route never spawned git here.
		assert.equal(
			g(['diff', '--cached', '--name-only']).trim(),
			'a.ts',
			'index untouched in pr mode',
		)
		// The reviewer-owned slice is still cleared, git or no git.
		assert.deepEqual(st.comments, [])
	} finally {
		handle.server.close()
		process.env.HOME = oldHome
		await rm(root, { recursive: true, force: true })
	}
})

void test('settings API round-trips editorCommand', async () => {
	await withServer(async handle => {
		await fetch(`${handle.url}api/settings`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				settings: { editorCommand: 'cursor -g {file}:{line}' },
			}),
		})
		const res = await fetch(`${handle.url}api/settings`)
		const loaded = await readJson<{
			settings?: { editorCommand?: string }
		}>(res)
		assert.equal(loaded.settings?.editorCommand, 'cursor -g {file}:{line}')
	})
})

void test('stable-port EADDRINUSE falls back to a different port instead of throwing', async () => {
	// A restarted desk's stablePort (deterministic per repo+session) can still be held by another
	// process - startServer must rebind elsewhere rather than crash the launch.
	const root = await mkdtemp(path.join(tmpdir(), 'galley-portfallback-'))
	const oldHome = process.env.HOME
	process.env.HOME = root
	const occupied = http.createServer()
	await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
	const address = occupied.address()
	const takenPort = typeof address === 'object' && address ? address.port : 0
	try {
		const handle = await startServer({
			state: state(root),
			open: false,
			idleTimeoutMs: 0,
			port: takenPort,
		})
		try {
			const boundPort = Number(new URL(handle.url).port)
			assert.notEqual(
				boundPort,
				takenPort,
				'rebound to a different, non-zero port',
			)
			assert.ok(boundPort > 0)
			const res = await fetch(`${handle.url}api/state`)
			assert.equal(
				res.status,
				200,
				'the fallback server actually answers',
			)
		} finally {
			handle.server.close()
		}
	} finally {
		occupied.close()
		process.env.HOME = oldHome
		await rm(root, { recursive: true, force: true })
	}
})

void test('a whole-file comment (lineNumber 0) anchors to the file, drops the line anchor, and normalizes side', async () => {
	await withServer(async handle => {
		// A deletions-side habit on a file comment must not fork the thread key: line 0 has no
		// diff side, so it stores the additions placeholder.
		const res = await post(handle.url, 'api/comment', {
			path: 'a.ts',
			side: 'deletions',
			lineNumber: 0,
			body: 'rename this module',
			role: 'user',
		})
		assert.equal(res.status, 200)
		const st = await getState(handle.url)
		const fileComment = st.comments.find(c => c.path === 'a.ts')
		assert.ok(fileComment, 'comment persisted')
		assert.equal(fileComment.lineNumber, 0)
		assert.equal(fileComment.anchor, 'file')
		assert.equal(fileComment.side, 'additions')
		assert.equal(fileComment.anchorText, undefined)

		// A `--line 0` agent reply keys the same file-level group (side/line placeholders equal).
		await post(handle.url, 'api/comment', {
			path: 'a.ts',
			lineNumber: 0,
			body: 'sure, where?',
			role: 'agent',
		})
		const replied = await getState(handle.url)
		assert.equal(replied.comments.length, 2)
		const reply = replied.comments.find(c => c.role === 'agent')
		assert.ok(reply)
		assert.equal(reply.side, fileComment.side)
		assert.equal(reply.lineNumber, fileComment.lineNumber)
	})
})

void test('a whole-file ask carries anchor file through the question event and the Send fold', async () => {
	await withServer(async handle => {
		await post(handle.url, 'api/ask', {
			path: 'a.ts',
			lineNumber: 0,
			body: 'should this be async?',
		})
		const event = await readJson<AwaitEvent>(
			await fetch(`${handle.url}api/await-send`),
		)
		if (event.kind !== 'question')
			assert.fail('await-send handed back a question event')
		const live = event.questions.at(-1)
		assert.ok(live)
		assert.equal(live.lineNumber, 0)
		assert.equal(live.anchor, 'file')
	})
})

void test('a whole-file Send carries the file request with anchor file (requestedChanges)', async () => {
	await withServer(async handle => {
		// The reviewer asks for a whole-file change from the diff header, then sends. The Send
		// body omits `comments` (the reviewer slice merges only posted keys), so the open file
		// comment survives into the result.
		const commentRes = await post(handle.url, 'api/comment', {
			path: 'a.ts',
			lineNumber: 0,
			body: 'add a header comment',
			role: 'user',
		})
		assert.equal(commentRes.status, 200)
		await post(handle.url, 'api/send', {})
		const review = await readJson<AwaitEvent>(
			await fetch(`${handle.url}api/await-send`),
		)
		if (review.kind !== 'review')
			assert.fail('await-send handed back the review event')
		assert.equal(review.result.requestedChanges.length, 1)
		const [fileRequest] = review.result.requestedChanges
		assert.equal(fileRequest.path, 'a.ts')
		assert.equal(fileRequest.lineNumber, 0)
		assert.equal(fileRequest.anchor, 'file')
	})
})
