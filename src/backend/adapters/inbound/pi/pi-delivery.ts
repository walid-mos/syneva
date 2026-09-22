import { errorMessage } from '../../../application/errors.js'

import {
	buildCorrectivePrompt,
	buildCorrespondentPrompt,
	correspondentIo,
	parseCorrespondentReply,
} from './correspondent.js'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { CorrespondentIo } from './correspondent.js'
import type { DeskConnection, DeskTarget } from './desk-connection.js'

// Only review and closed events (plus rare correspondent failures) reach the owning
// session. Questions are answered by the desk correspondent instead - answering in the
// owner would re-send every read on all later turns of the round, and routing it there
// makes the session a router instead of a reviewer. wakeDeskOwner is the ONE owner wake.
export function wakeDeskOwner(
	pi: Pick<ExtensionAPI, 'sendMessage'>,
	target: DeskTarget,
	eventPath: string,
	extra?: string,
): void {
	pi.sendMessage(
		{
			customType: 'syneva-event',
			content: [
				`Syneva feedback for repo ${JSON.stringify(target.repo)}, session ${JSON.stringify(target.session)}.`,
				`Read the complete event at ${JSON.stringify(eventPath)} and follow syneva spec (read it once per session).`,
				'Questions on this desk are answered automatically by the desk correspondent; do not answer them in this session. This wake is for a review event (or a correspondent failure):',
				'- review events: act on the feedback in this session, then syneva reload.',
				"- closed events: detach with syneva_agent {action:'detach'} and return control - the human closed the review; restart the desk never.",
				...(extra
					? [
							`- correspondent failure: ${extra}. Answer the questions yourself with syneva comment,`,
							"posting each answer VERBATIM at the question's own path/line/side; answering is READ-ONLY.",
						]
					: []),
				'The native listener stays attached across turns. Never launch syneva await or a child whose job is to wait. Return control after handling feedback; further events wake this session automatically.',
			].join('\n'),
			display: true,
			details: { ...target, eventPath },
		},
		{ triggerTurn: true, deliverAs: 'followUp' },
	)
}

// The answer pipeline for ONE question event: run the single desk correspondent thread,
// parse its block replies, and post them at the envelope's own anchors. One corrective
// turn rescues a format slip; anything else falls back to one owner wake carrying the
// failure, so a dead correspondent degrades to the ask-the-owner flow instead of
// dropping the question. Aborted attachments stay silent.
export async function handleQuestionEvent(input: {
	pi: Pick<ExtensionAPI, 'sendMessage'>
	desk: DeskConnection
	eventPath: string
	signal: AbortSignal
	io?: CorrespondentIo
}): Promise<void> {
	const { pi, desk, eventPath, signal } = input
	const io: CorrespondentIo = input.io ?? correspondentIo
	try {
		if (signal.aborted) return
		const questions = await io.readQuestions(eventPath)
		if (!questions.length)
			throw new Error('the event holds no answerable questions')
		const prompt = buildCorrespondentPrompt(desk, eventPath, questions)
		let text = await io.runCorrespondent(desk, prompt, signal)
		let replies: string[]
		try {
			replies = parseCorrespondentReply(text, questions.length)
		} catch {
			text = await io.runCorrespondent(
				desk,
				buildCorrectivePrompt(questions.length),
				signal,
			)
			replies = parseCorrespondentReply(text, questions.length)
		}
		for (const [index, question] of questions.entries())
			await io.postDeskComment(desk, question, replies.at(index) ?? '')
	} catch (error) {
		if (signal.aborted) return
		const detail = errorMessage(error)
		wakeDeskOwner(
			pi,
			desk,
			eventPath,
			`the desk correspondent failed (${detail})`,
		)
	}
}
