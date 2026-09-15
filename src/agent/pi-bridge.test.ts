import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import {
	buildCorrectivePrompt,
	parseCorrespondentReply,
	readQuestions,
} from './correspondent.js'
import { localDeskUrl } from './desk-connection.js'
import { savedAttachment } from './pi-attachment.js'
import { handleQuestionEvent, wakeDeskOwner } from './pi-delivery.js'
import {
	buildPiArgs,
	correspondentEnv,
	correspondentSessionFile,
	resolvePiEntry,
	runPiProcess,
} from './pi-thread.js'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { CorrespondentIo, DeskQuestion } from './correspondent.js'
import type { DeskConnection } from './desk-connection.js'

function fakePi(): {
	pi: Pick<ExtensionAPI, 'sendMessage'>
	delivered: string[]
} {
	const delivered: string[] = []
	const pi: Pick<ExtensionAPI, 'sendMessage'> = {
		sendMessage: message => {
			delivered.push(JSON.stringify(message))
		},
	}
	return { pi, delivered }
}

function fakeDesk(): DeskConnection {
	return {
		repo: '/repo',
		session: 'review',
		url: 'http://127.0.0.1:47121/',
		directory: '/galley/review',
	}
}

function fakeIo(behavior: {
	run?: (prompt: string) => string
	posted?: { question: DeskQuestion; body: string }[]
	throw?: unknown
	failPostsOnIndex?: number[]
}): CorrespondentIo {
	return {
		readQuestions,
		runCorrespondent: async (_desk, prompt) => {
			if (behavior.throw) throw behavior.throw
			return behavior.run?.(prompt) ?? ''
		},
		postDeskComment: async (_desk, question, body) => {
			const index = behavior.posted?.length ?? 0
			if (behavior.failPostsOnIndex?.includes(index))
				throw new Error('HTTP 500')
			behavior.posted?.push({ question, body })
		},
	}
}

async function writeEventFile(questions: unknown[]): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'galley-event-'))
	const file = path.join(dir, 'pi-event-x.json')
	await writeFile(file, JSON.stringify({ kind: 'question', questions }))
	return file
}

const ANSWERS = '### q1\nPremière réponse.\n\n### q2\nDeuxième réponse.'
const TWO_QUESTIONS = [
	{
		path: 'src/app.ts',
		lineNumber: 28,
		side: 'deletions',
		body: 'Pourquoi ce dedup ?',
		mode: 'repo',
	},
	{
		path: 'src/agent/desk-listener.ts',
		lineNumber: 3,
		side: 'additions',
		body: 'Et ce timer ?',
		mode: 'repo',
	},
]

void test('review events wake the owner; the wake text is router-free', () => {
	const { pi, delivered } = fakePi()
	wakeDeskOwner(
		pi,
		{ repo: '/repo', session: 'review' },
		'/events/review.json',
	)
	assert.equal(delivered.length, 1)
	const text = delivered[0] ?? ''
	assert.match(text, /\/events\/review\.json/)
	assert.match(text, /follow galley spec/)
	assert.match(
		text,
		/act on the feedback in this session, then galley reload/,
	)
	assert.match(text, /galley_agent \{action:'detach'\}/)
	// The child-routing instructions left with the old contract.
	assert.doesNotMatch(text, /NEVER answer a question/)
	assert.match(text, /answered automatically by the desk correspondent/i)
})

void test('a correspondent failure adds an actionable fallback to the owner wake', () => {
	const { pi, delivered } = fakePi()
	wakeDeskOwner(
		pi,
		{ repo: '/repo', session: 'review' },
		'/events/q.json',
		'the desk correspondent failed (boom)',
	)
	assert.equal(delivered.length, 1)
	const text = delivered[0] ?? ''
	assert.match(
		text,
		/correspondent failure: the desk correspondent failed \(boom\)/,
	)
	assert.match(text, /answer the questions yourself with galley comment/i)
	assert.match(text, /VERBATIM/)
})

void test('questions are answered by the correspondent and posted, never waking the owner', async () => {
	const { pi, delivered } = fakePi()
	const eventPath = await writeEventFile(TWO_QUESTIONS)
	const posted: { question: DeskQuestion; body: string }[] = []
	const io = fakeIo({ run: () => ANSWERS, posted })
	await handleQuestionEvent({
		pi,
		desk: fakeDesk(),
		eventPath,
		signal: new AbortController().signal,
		io,
	})
	assert.ok(
		isDeepStrictEqual(
			posted.map(record => [
				record.question.path,
				record.question.side,
				record.question.lineNumber,
			]),
			[
				['src/app.ts', 'deletions', 28],
				['src/agent/desk-listener.ts', 'additions', 3],
			],
		),
	)
	assert.match(posted[0]?.body ?? '', /Première réponse\./)
	assert.match(posted[1]?.body ?? '', /Deuxième réponse\./)
	assert.equal(delivered.length, 0)
})

void test('the correspondent prompt carries repo, event path and the reply format', async () => {
	let seen = ''
	const io = fakeIo({
		run: prompt => {
			seen = prompt
			return ANSWERS
		},
	})
	const eventPath = await writeEventFile(TWO_QUESTIONS)
	await handleQuestionEvent({
		pi: fakePi().pi,
		desk: fakeDesk(),
		eventPath,
		signal: new AbortController().signal,
		io,
	})
	assert.match(seen, /"\/repo"/)
	assert.match(seen, /pi-event-x\.json/)
	assert.match(seen, /### q<N>/)
	assert.match(seen, /never edit files/)
	// The answers themselves must never leak into the prompt.
	assert.doesNotMatch(seen, /Première réponse/)
})

void test('a malformed reply gets one corrective turn, then success', async () => {
	const { pi } = fakePi()
	const eventPath = await writeEventFile([TWO_QUESTIONS[0]])
	const posted: { question: DeskQuestion; body: string }[] = []
	let turns = 0
	const io = fakeIo({
		run: () => {
			turns++
			return turns === 1
				? 'I looked at the code but forgot the format.'
				: '### q1\nRéété correctement.'
		},
		posted,
	})
	await handleQuestionEvent({
		pi,
		desk: fakeDesk(),
		eventPath,
		signal: new AbortController().signal,
		io,
	})
	assert.equal(turns, 2)
	assert.equal(posted.length, 1)
	assert.match(posted[0]?.body ?? '', /Réété correctement/)
})

async function expectFallbackWake(
	label: string,
	behavior: Parameters<typeof fakeIo>[0],
	questions: unknown[],
): Promise<void> {
	const { pi, delivered } = fakePi()
	const eventPath = await writeEventFile(questions)
	await handleQuestionEvent({
		pi,
		desk: fakeDesk(),
		eventPath,
		signal: new AbortController().signal,
		io: fakeIo(behavior),
	})
	assert.equal(delivered.length, 1, label)
	const text = delivered[0] ?? ''
	assert.match(text, /correspondent failure:/, label)
	assert.match(
		text,
		/answer the questions yourself with galley comment/i,
		label,
	)
	assert.match(text, /VERBATIM/, label)
}

void test('a dead or unusable correspondent falls back to exactly one owner wake', async () => {
	const single = [TWO_QUESTIONS[0]]
	await expectFallbackWake(
		'spawn throws',
		{ throw: new Error('ENOENT: pi') },
		single,
	)
	await expectFallbackWake(
		'garbled reply twice',
		{ run: () => '### q1' },
		single,
	)
	await expectFallbackWake(
		'post fails',
		{ run: () => '### q1\nOk.', failPostsOnIndex: [0] },
		single,
	)
	await expectFallbackWake('empty event', { run: () => ANSWERS }, [])
})

void test('an aborted attachment answers nothing and wakes nobody', async () => {
	const { pi, delivered } = fakePi()
	const controller = new AbortController()
	controller.abort()
	const eventPath = await writeEventFile([TWO_QUESTIONS[0]])
	await handleQuestionEvent({
		pi,
		desk: fakeDesk(),
		eventPath,
		signal: controller.signal,
		io: fakeIo({ run: () => ANSWERS }),
	})
	assert.equal(delivered.length, 0)
})

void test('the correspondent thread is one fixed session file per desk', () => {
	const file = correspondentSessionFile(fakeDesk())
	assert.match(file, /correspondent-session\.jsonl$/)
	const argvBefore = process.argv.slice()
	try {
		process.argv = ['pi', '/tools/pi/dist/cli.js']
		const entry = resolvePiEntry()
		assert.equal(entry.prefixArgs.length, 1)
		// The isolation flags keep the child from loading extensions (no listener
		// inheritance), skills, themes, or project context files.
		const args = buildPiArgs(file, 'hello')
		assert.equal(args[0], '-p')
		assert.ok(args.includes('--no-extensions'))
		assert.ok(args.includes('--no-context-files'))
		assert.ok(args.includes('--tools'))
		assert.ok(isDeepStrictEqual(args.slice(-2), [file, 'hello']))
	} finally {
		process.argv = argvBefore
	}
})

void test(
	'the thread process gets a closed stdin (the execFile hang), a clean exit and an abort',
	{ timeout: 30_000 },
	async () => {
		// `pi -p` waits for stdin EOF: with the default open pipe it hangs forever. This
		// child prints ONLY when stdin ends, so an open stdin would stall the test.
		const stdinEof =
			"process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('STDIN-EOF'))"
		const out = await runPiProcess(process.execPath, ['-e', stdinEof], {
			cwd: '/tmp',
			env: process.env,
			signal: AbortSignal.timeout(20_000),
		})
		assert.match(out, /STDIN-EOF/)

		await assert.rejects(
			runPiProcess(
				process.execPath,
				['-e', "process.stderr.write('boom'); process.exit(3)"],
				{
					cwd: '/tmp',
					env: process.env,
					signal: AbortSignal.timeout(20_000),
				},
			),
			/exited with code 3: boom/,
		)

		const controller = new AbortController()
		controller.abort()
		await assert.rejects(
			runPiProcess(
				process.execPath,
				['-e', 'setTimeout(() => {}, 30_000)'],
				{
					cwd: '/tmp',
					env: process.env,
					signal: controller.signal,
				},
			),
			/aborted|timed out/,
		)
	},
)

void test('the thread env drops embedding markers but keeps provider config', () => {
	const env = correspondentEnv({
		PATH: '/usr/bin',
		PI_PROVIDER: 'deepseek',
		PI_MODEL: 'deepseek-v4-flash-vision-exp',
		PI_REASONING_LEVEL: 'high',
		PI_CODING_AGENT: 'true',
		PI_SESSION_ID: 'session-1',
		PI_SESSION_FILE: '/sessions/mine.jsonl',
		PI_SUBAGENT_PARENT_SESSION: 'parent-1',
	})
	// Kept: the thread answers with the owner's model configuration and credentials.
	assert.equal(env['PI_PROVIDER'], 'deepseek')
	assert.equal(env['PI_MODEL'], 'deepseek-v4-flash-vision-exp')
	assert.equal(env['PI_REASONING_LEVEL'], 'high')
	assert.equal(env['PATH'], '/usr/bin')
	// Dropped: inheriting these makes a spawned `pi -p` attach to the parent session
	// protocol and hang instead of answering.
	assert.equal(env['PI_CODING_AGENT'], undefined)
	assert.equal(env['PI_SESSION_ID'], undefined)
	assert.equal(env['PI_SESSION_FILE'], undefined)
	assert.equal(env['PI_SUBAGENT_PARENT_SESSION'], undefined)
})

void test('corrective prompt asks for the blocks again, nothing else', () => {
	const prompt = buildCorrectivePrompt(2)
	assert.match(prompt, /Re-emit the answers/)
	assert.match(prompt, /### q<N>/)
	assert.match(prompt, /\b2\b/)
})

void test('reply parser keeps only question order and bodies', () => {
	assert.ok(
		isDeepStrictEqual(
			parseCorrespondentReply(
				'preamble ignored\n### q1\nUn.\n### q2\nDeux.\n### q3\nTrois.',
				3,
			),
			['Un.', 'Deux.', 'Trois.'],
		),
	)
	assert.throws(
		() => parseCorrespondentReply('### q1\nOk.', 2),
		/missing block q2/,
	)
	assert.throws(
		() => parseCorrespondentReply('### q2\nSkipped one.', 2),
		/missing block q1/,
	)
	assert.throws(
		() => parseCorrespondentReply('### q1\n\n### q2\nOk.', 2),
		/block q1 is empty/,
	)
	assert.throws(
		() => parseCorrespondentReply('### q1\nA.\n### q1\nAgain.', 1),
		/repeats block q1/,
	)
})

void test('envelope reading accepts the batched and compat forms and rejects junk', async () => {
	const batched = await writeEventFile(TWO_QUESTIONS)
	assert.equal((await readQuestions(batched)).length, 2)
	const single = await writeEventFile([TWO_QUESTIONS[0]])
	const dir = path.dirname(single)
	const compat = path.join(dir, 'pi-event-compat.json')
	await writeFile(
		compat,
		JSON.stringify({ kind: 'question', question: TWO_QUESTIONS[0] }),
	)
	assert.equal((await readQuestions(compat)).length, 1)
	const junk = path.join(dir, 'pi-event-junk.json')
	await writeFile(
		junk,
		JSON.stringify({ questions: [{ path: 3 }, null, TWO_QUESTIONS[0]] }),
	)
	const filtered = await readQuestions(junk)
	assert.equal(filtered.length, 1)
	const empty = path.join(dir, 'pi-event-none.json')
	await writeFile(empty, JSON.stringify({ kind: 'question' }))
	assert.deepEqual(await readQuestions(empty), [])
})

void test('reload restores the same owner but forks cannot inherit the parent listener', () => {
	const entries = [
		{
			type: 'custom',
			customType: 'galley-attachment',
			data: { owner: 'parent', target: { repo: '/repo', session: 's' } },
		},
	]
	assert.deepEqual(savedAttachment(entries, 'parent'), {
		repo: '/repo',
		session: 's',
	})
	assert.equal(savedAttachment(entries, 'child'), undefined)
})

void test('explicit detach prevents a later resume from resurrecting the listener', () => {
	const entries = [
		{
			type: 'custom',
			customType: 'galley-attachment',
			data: { owner: 'parent', target: { repo: '/repo', session: 's' } },
		},
		{
			type: 'custom',
			customType: 'galley-attachment',
			data: { owner: 'parent', target: undefined },
		},
	]
	assert.equal(savedAttachment(entries, 'parent'), undefined)
})

void test('attachments refuse non-loopback or credential-bearing desk URLs', () => {
	for (const url of [
		'https://example.com/',
		'http://example.com/',
		'http://127.0.0.1.example.com/',
		'http://user:pass@localhost/',
	])
		assert.throws(() => localDeskUrl(url), /loopback/)
	assert.equal(localDeskUrl('http://127.0.0.1:42000/').port, '42000')
})
