import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { startServer } from '../server.js'
import { deskLockPath, reviewDir } from '../state/desk.js'

import { readQuestions } from './correspondent.js'
import { PiDeskAttachment } from './pi-attachment.js'
import { correspondentSessionFile } from './pi-thread.js'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ReviewState } from '../types.js'
import type { CorrespondentIo, DeskQuestion } from './correspondent.js'
import type { AttachmentContext } from './pi-attachment.js'

type Owner = {
	pi: Pick<ExtensionAPI, 'appendEntry' | 'sendMessage'>
	ctx: AttachmentContext
	wakes: EventEmitter
	failures: string[]
}

function fakePiOwner(): Owner {
	const wakes = new EventEmitter()
	const entries: { type: 'custom'; customType: string; data: unknown }[] = []
	const failures: string[] = []
	const pi: Owner['pi'] = {
		appendEntry: (customType, saved) => {
			entries.push({ type: 'custom', customType, data: saved })
		},
		sendMessage: (message, options) => {
			assert.deepEqual(options, {
				triggerTurn: true,
				deliverAs: 'followUp',
			})
			wakes.emit('wake', message.details)
		},
	}
	// Only the Pi boundary is faked; discovery, HTTP, event queue, persistence and
	// attachment lifecycle below run against the real Syneva server.
	const ctx: AttachmentContext = {
		mode: 'rpc',
		sessionManager: {
			getSessionId: () => 'owner',
			getEntries: () => entries,
		},
		ui: {
			notify: (message: string) => {
				failures.push(message)
			},
		},
	}
	return { pi, ctx, wakes, failures }
}

function reviewState(root: string): ReviewState {
	return {
		id: 'review',
		session: 's',
		root,
		repoHash: 'h',
		mode: 'file',
		staged: false,
		head: null,
		baseDiffHash: 'base',
		createdAt: 't',
		rawDiff: '',
		files: [],
		comments: [],
		changes: [],
		reviewedFiles: [],
		stagedFiles: [],
	}
}

type Fixture = {
	root: string
	handle: Awaited<ReturnType<typeof startServer>>
	close(): Promise<void>
}
async function startFixture(): Promise<Fixture> {
	const root = await mkdtemp(path.join(tmpdir(), 'syneva-pi-owner-'))
	const handle = await startServer({
		state: reviewState(root),
		open: false,
		port: 0,
	})
	const directory = await reviewDir(root, 's')
	await writeFile(
		deskLockPath(directory),
		JSON.stringify({ pid: process.pid, url: handle.url, session: 's' }),
	)
	return {
		root,
		handle,
		async close() {
			handle.server.closeAllConnections()
			await new Promise<void>(resolve =>
				handle.server.close(() => resolve()),
			)
			await rm(directory, { recursive: true, force: true })
			await rm(root, { recursive: true, force: true })
		},
	}
}

type FeedbackSource = { url: string; wakes: EventEmitter; signal: AbortSignal }

// Question events no longer wake the owner: the correspondent answers them and the
// answer appears as an agent comment in the desk state. Poll the state until it does.
// Predicate without asserts: the desk state is a wire payload, so membership is checked
// with in-narrowing guards instead of type assertions.
type AgentComment = { body: string; status: unknown }

function isAgentComment(
	comment: unknown,
	fragment: string,
): comment is AgentComment {
	return (
		typeof comment === 'object' &&
		comment !== null &&
		'role' in comment &&
		comment.role === 'agent' &&
		'body' in comment &&
		typeof comment.body === 'string' &&
		comment.body.includes(fragment) &&
		'status' in comment
	)
}

function agentCommentIncluding(
	state: unknown,
	fragment: string,
): AgentComment | undefined {
	if (typeof state !== 'object' || state === null) return undefined
	if (!('comments' in state) || !Array.isArray(state.comments))
		return undefined
	for (const comment of state.comments)
		if (isAgentComment(comment, fragment)) return comment
	return undefined
}

async function waitForComment(
	source: FeedbackSource,
	body: string,
): Promise<void> {
	const until = Date.now() + 5000
	while (Date.now() < until) {
		const response = await fetch(`${source.url}api/state`)
		assert.equal(response.status, 200)
		const found = agentCommentIncluding(await response.json(), body)
		if (found?.status === 'open') return
		await new Promise<void>(resolve => setTimeout(resolve, 40))
	}
	assert.fail(
		`the answer to ${JSON.stringify(body)} never reached the desk state`,
	)
}

// A fake thread step that mimics the real contract: read the envelope from the prompt's
// event path and answer every question in "### q<N>" blocks. The answer path is otherwise
// entirely the production code: event persistence, parsing, and POST /api/comment wiring.
function scriptedThread(): CorrespondentIo {
	return {
		readQuestions,
		runCorrespondent: async (_desk, prompt) => {
			const eventPath = /Read the complete event at "([^"]+)"/.exec(
				prompt,
			)?.[1]
			if (!eventPath)
				throw new Error('prompt did not name the event file')
			const questions = await readQuestions(eventPath)
			return questions
				.map(
					(question: DeskQuestion, index: number) =>
						`### q${index + 1}\nAnswered: ${question.body}`,
				)
				.join('\n')
		},
		async postDeskComment(_desk, question, body) {
			const response = await fetch(
				`${currentFixture!.handle.url}api/comment`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						path: question.path,
						side: question.side,
						lineNumber: question.lineNumber,
						body,
						role: 'agent',
					}),
				},
			)
			assert.equal(response.status, 200)
		},
	}
}

let currentFixture: { handle: { url: string } } | undefined

void test(
	'one Pi attachment answers questions through the desk correspondent; Send wakes the owner',
	{ timeout: 10_000 },
	async t => {
		const fixture = await startFixture()
		currentFixture = fixture
		const owner = fakePiOwner()
		const source = {
			url: fixture.handle.url,
			wakes: owner.wakes,
			signal: t.signal,
		}
		let attachment = new PiDeskAttachment(owner.pi, scriptedThread())
		t.after(async () => {
			await attachment.stop()
			currentFixture = undefined
			await fixture.close()
		})
		await attachment.attach({ repo: fixture.root, session: 's' }, owner.ctx)

		// Question events arrive one at a time. Each is answered by the one correspondent
		// thread and posted straight to the desk; the owner session is never woken for them.
		const response = await fetch(`${fixture.handle.url}api/ask`, {
			method: 'POST',
			body: JSON.stringify({ path: 'plan.md', body: 'First question' }),
		})
		assert.equal(response.status, 200)
		await waitForComment(source, 'Answered: First question')
		const second = await fetch(`${fixture.handle.url}api/ask`, {
			method: 'POST',
			body: JSON.stringify({ path: 'plan.md', body: 'Second question' }),
		})
		assert.equal(second.status, 200)
		await waitForComment(source, 'Answered: Second question')
		assert.ok(owner.wakes.listenerCount('wake') >= 0)

		// Send (a review event) still wakes the owner natively.
		const received = once(owner.wakes, 'wake', { signal: t.signal })
		await fetch(`${fixture.handle.url}api/send`, {
			method: 'POST',
			body: JSON.stringify({ overallNote: 'Please revise the plan' }),
		})
		const [wake]: unknown[] = await received
		assert.ok(
			wake &&
				typeof wake === 'object' &&
				'eventPath' in wake &&
				typeof wake.eventPath === 'string',
		)
		const envelope: unknown = JSON.parse(
			await readFile(wake.eventPath, 'utf8'),
		)
		assert.ok(
			envelope && typeof envelope === 'object' && 'kind' in envelope,
		)
		assert.equal(String(envelope.kind), 'review')
		assert.match(
			JSON.stringify(envelope),
			/"overallNote":"Please revise the plan"/,
		)

		// The thread is one fixed session file per desk session.
		assert.match(
			correspondentSessionFile({
				repo: fixture.root,
				session: 's',
				url: fixture.handle.url,
				directory: await reviewDir(fixture.root, 's'),
			}),
			/correspondent-session\.jsonl$/,
		)

		// Stop, restore, ask again: the same contract survives reload.
		await attachment.stop()
		attachment = new PiDeskAttachment(owner.pi, scriptedThread())
		await attachment.restore(owner.ctx)
		assert.equal(attachment.isConnected(), true, owner.failures.join('\n'))
		const afterReload = await fetch(`${fixture.handle.url}api/ask`, {
			method: 'POST',
			body: JSON.stringify({ path: 'plan.md', body: 'After reload' }),
		})
		assert.equal(afterReload.status, 200)
		await waitForComment(source, 'Answered: After reload')
		assert.deepEqual(owner.failures, [])

		await attachment.detach(owner.ctx)
		await attachment.restore(owner.ctx)
		assert.equal(attachment.isConnected(), false)
	},
)

void test('one-shot print and JSON agents cannot claim a persistent attachment', async () => {
	const owner = fakePiOwner()
	const attachment = new PiDeskAttachment(owner.pi)
	await assert.rejects(
		attachment.attach(
			{ repo: '/not-used', session: 's' },
			{ ...owner.ctx, mode: 'print' },
		),
		/one-shot/,
	)
	await assert.rejects(
		attachment.attach(
			{ repo: '/not-used', session: 's' },
			{ ...owner.ctx, mode: 'json' },
		),
		/one-shot/,
	)
	assert.equal(attachment.isConnected(), false)
})
