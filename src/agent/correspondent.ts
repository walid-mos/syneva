import { readFile } from 'node:fs/promises'

import { runCorrespondent } from './pi-thread.js'

import type { DeskConnection, DeskTarget } from './desk-connection.js'

// These belong to the desk event semantics too, so they are re-exported by the delivery
// layer; the mechanism (spawning and reading one pi thread) stays in this file.
export type DeskQuestion = {
	path: string
	lineNumber: number
	side: 'additions' | 'deletions'
	body: string
	mode?: string
}

export type CorrespondentIo = {
	readQuestions: (eventPath: string) => Promise<DeskQuestion[]>
	runCorrespondent: (
		connection: DeskConnection,
		prompt: string,
		signal: AbortSignal,
	) => Promise<string>
	postDeskComment: (
		desk: DeskConnection,
		question: DeskQuestion,
		body: string,
	) => Promise<void>
}

const POST_COMMENT_TIMEOUT_MS = 10_000
// Answers are prose; the cap only guards against runaway output before the parser sees it.

export function buildCorrespondentPrompt(
	target: DeskTarget,
	eventPath: string,
	questions: DeskQuestion[],
): string {
	const count = questions.length
	return [
		`Galley review question for repo ${JSON.stringify(target.repo)}, session ${JSON.stringify(target.session)}.`,
		`Read the complete event at ${JSON.stringify(eventPath)} (it holds these questions).`,
		`Answer ${count === 1 ? 'it' : `all ${count} of them`} read-only: read the anchored code as needed to answer, never edit files, never run desk commands.`,
		"Answer in the reviewer's language.",
		'Reply format - for each question in order, emit exactly:',
		'### q<N>',
		'<the answer, plain text>',
		'Nothing before the first block, nothing after the last.',
	].join('\n')
}

export function buildCorrectivePrompt(count: number): string {
	return [
		'Your previous reply was not in the required format.',
		`Re-emit the answers now: for each of the ${count} question(s) in order, exactly:`,
		'### q<N>',
		'<the answer, plain text>',
		'Nothing else in the reply.',
	].join('\n')
}

// Replies parse out of "### q<N>" blocks, one per question, in question order. The anchor
// is NOT taken from the reply - the desk envelope owns authoritative path/line/side, so
// only the body is read here. Extra blocks are tolerated; missing or empty blocks throw.
export function parseCorrespondentReply(text: string, count: number): string[] {
	const marks = [...text.matchAll(/^###\s*q(\d+)\s*$/gm)]
	const bodies = new Map<number, string>()
	for (const [index, mark] of marks.entries()) {
		const [blockNumberText] = mark.slice(1)
		const blockNumber = Number(blockNumberText)
		if (bodies.has(blockNumber))
			throw new Error(
				`the correspondent reply repeats block q${blockNumber}`,
			)
		const following = marks.at(index + 1)
		const start = mark.index + mark[0].length
		const end = following ? following.index : undefined
		bodies.set(blockNumber, text.slice(start, end).trim())
	}
	const replies: string[] = []
	for (let position = 1; position <= count; position++) {
		if (!bodies.has(position))
			throw new Error(
				`the correspondent reply is missing block q${position}`,
			)
		const body = bodies.get(position) ?? ''
		if (!body)
			throw new Error(
				`the correspondent reply block q${position} is empty`,
			)
		replies.push(body)
	}
	return replies
}

// The saved event envelope is the ground truth: path/lineNumber/side per question come
// from the desk, never from the reply. Accepts both the batched `questions[]` form and
// the single-`question` compatibility field.
export async function readQuestions(
	eventPath: string,
): Promise<DeskQuestion[]> {
	const envelope: unknown = JSON.parse(await readFile(eventPath, 'utf8'))
	if (typeof envelope !== 'object' || envelope === null) return []
	return questionListOf(envelope).filter(isDeskQuestion)
}

function questionListOf(scope: object): unknown[] {
	if ('questions' in scope && Array.isArray(scope.questions))
		return scope.questions
	if ('question' in scope && isDeskQuestion(scope.question))
		return [scope.question]
	return []
}

function isDeskQuestion(candidate: unknown): candidate is DeskQuestion {
	return (
		typeof candidate === 'object' &&
		candidate !== null &&
		'path' in candidate &&
		typeof candidate.path === 'string' &&
		'lineNumber' in candidate &&
		typeof candidate.lineNumber === 'number' &&
		'side' in candidate &&
		(candidate.side === 'additions' || candidate.side === 'deletions') &&
		'body' in candidate &&
		typeof candidate.body === 'string'
	)
}

// Same wire shape the `galley comment` CLI posts, so replies show up live in the desk.
export async function postDeskComment(
	desk: DeskConnection,
	question: DeskQuestion,
	body: string,
): Promise<void> {
	const response = await fetch(new URL('/api/comment', desk.url), {
		method: 'POST',
		signal: AbortSignal.timeout(POST_COMMENT_TIMEOUT_MS),
		redirect: 'error',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			path: question.path,
			side: question.side,
			lineNumber: question.lineNumber,
			body,
			role: 'agent',
		}),
	})
	if (!response.ok)
		throw new Error(`POST /api/comment failed: HTTP ${response.status}`)
}

// Default wiring used by the live attachment; tests inject fakes instead.
export const correspondentIo: CorrespondentIo = {
	readQuestions,
	runCorrespondent,
	postDeskComment,
}
