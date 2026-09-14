import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { startServer } from '../server.js'
import { deskLockPath, reviewDir } from '../state/desk.js'

import { PiDeskAttachment } from './pi-attachment.js'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ReviewState } from '../types.js'
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
	// attachment lifecycle below run against the real Galley server.
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
	const root = await mkdtemp(path.join(tmpdir(), 'galley-pi-owner-'))
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
async function feedback(
	source: FeedbackSource,
	route: string,
	payload: object,
): Promise<Record<string, unknown>> {
	const received = once(source.wakes, 'wake', { signal: source.signal })
	const response = await fetch(`${source.url}api/${route}`, {
		method: 'POST',
		body: JSON.stringify(payload),
	})
	assert.equal(response.status, 200)
	const [wake]: unknown[] = await received
	assert.ok(
		wake &&
			typeof wake === 'object' &&
			'eventPath' in wake &&
			typeof wake.eventPath === 'string',
	)
	const envelope: unknown = JSON.parse(await readFile(wake.eventPath, 'utf8'))
	assert.ok(envelope && typeof envelope === 'object')
	return { ...envelope }
}

void test(
	'one Pi attachment wakes for two questions, Send, and another question after reload',
	{ timeout: 10_000 },
	async t => {
		const fixture = await startFixture()
		const owner = fakePiOwner()
		const source = {
			url: fixture.handle.url,
			wakes: owner.wakes,
			signal: t.signal,
		}
		let attachment = new PiDeskAttachment(owner.pi)
		t.after(async () => {
			await attachment.stop()
			await fixture.close()
		})
		await attachment.attach({ repo: fixture.root, session: 's' }, owner.ctx)
		const first = await feedback(source, 'ask', {
			path: 'plan.md',
			body: 'First question',
		})
		const second = await feedback(source, 'ask', {
			path: 'plan.md',
			body: 'Second question',
		})
		const review = await feedback(source, 'send', {
			overallNote: 'Please revise the plan',
		})
		assert.deepEqual(first.question, {
			path: 'plan.md',
			lineNumber: 1,
			side: 'additions',
			body: 'First question',
			mode: 'file',
			session: 's',
		})
		assert.deepEqual(second.question, {
			path: 'plan.md',
			lineNumber: 1,
			side: 'additions',
			body: 'Second question',
			mode: 'file',
			session: 's',
		})
		assert.equal(review.kind, 'review')
		assert.match(
			JSON.stringify(review.result),
			/"overallNote":"Please revise the plan"/,
		)
		await attachment.stop()
		attachment = new PiDeskAttachment(owner.pi)
		await attachment.restore(owner.ctx)
		assert.equal(attachment.isConnected(), true, owner.failures.join('\n'))
		const afterReload = await feedback(source, 'ask', {
			path: 'plan.md',
			body: 'After reload',
		})
		assert.equal(afterReload.kind, 'question')
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
