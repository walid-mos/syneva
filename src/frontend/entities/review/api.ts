import { API_PATHS } from '@contracts/routes'
import { api } from '@shared/api/client'
import {
	assertObject,
	DecodeError,
	optBoolean,
	optString,
	requiredBoolean,
} from '@shared/api/decode'

import {
	decodeDeskStateSnapshot,
	decodePollPayload,
	decodeReviewState,
} from './decode'

import type { ResetScope } from '@contracts/review'
import type {
	DeskPollSnapshot,
	DeskRefreshEvent,
	DeskStateSnapshot,
	DeskStatus,
	ReviewState,
	ReviewerSave,
} from './model'

// The review entity's API boundary: the only place review-domain endpoints are named.
// Paths come from @contracts/routes so the wire stays in sync with the desk by
// construction. Every response is decoded onto a frontend-owned model here - wire
// shapes never escape this module.

// Every side-effect POST this entity issues acknowledges with `{ ok: true }`: decode it
// so a 2xx body that lies still fails here, and no raw wire object escapes the boundary.
function decodeAck(raw: unknown, endpoint: string): void {
	const o = assertObject(raw, endpoint)
	if (!requiredBoolean(o, 'ok', endpoint))
		throw new DecodeError('acknowledgement ok is false', endpoint)
}

// Persist the reviewer-owned slice (snapshot semantics - see save.ts's reviewerSlice).
// The response carries the persisted stamp the tab doesn't consume.
export const saveReview = async (payload: ReviewerSave): Promise<void> => {
	decodeAck(
		await api(API_PATHS.save, {
			method: 'POST',
			body: JSON.stringify(payload),
		}),
		API_PATHS.save,
	)
}

// Stage/unstage a change as a side effect of a decision (the git index follows the
// decision record - the Decision, not the index, stays the source of truth).
export const stageChange = async (body: unknown): Promise<void> => {
	decodeAck(
		await api(API_PATHS.stage, {
			method: 'POST',
			body: JSON.stringify(body),
		}),
		API_PATHS.stage,
	)
}

export const unstageChange = async (body: unknown): Promise<void> => {
	decodeAck(
		await api(API_PATHS.unstage, {
			method: 'POST',
			body: JSON.stringify(body),
		}),
		API_PATHS.unstage,
	)
}

// One-way handoff of the finished review back to the attached agent (see /api/send).
export type SendResult = { sent?: boolean }

export const sendReview = async (payload: unknown): Promise<SendResult> => {
	const raw = await api(API_PATHS.send, {
		method: 'POST',
		body: JSON.stringify(payload),
	})
	return {
		sent: optBoolean(
			assertObject(raw, API_PATHS.send),
			'sent',
			API_PATHS.send,
		),
	}
}

// Push a question to the agent without ending the review round.
export const askAgent = async (body: unknown): Promise<void> => {
	decodeAck(
		await api(API_PATHS.ask, {
			method: 'POST',
			body: JSON.stringify(body),
		}),
		API_PATHS.ask,
	)
}

// Jump into the reviewer's local editor at a real file line (see features/open-editor).
export type EditorResult = { ok?: boolean; error?: string }

export const openEditor = async (body: {
	path: string
	lineNumber: number
}): Promise<EditorResult> => {
	const raw = await api(API_PATHS.openEditor, {
		method: 'POST',
		body: JSON.stringify(body),
	})
	const o = assertObject(raw, API_PATHS.openEditor)
	return {
		ok: optBoolean(o, 'ok', API_PATHS.openEditor),
		error: optString(o, 'error', API_PATHS.openEditor),
	}
}

// Destructive: drop every decision/comment and rebuild from the working tree. The
// answer carries the rebuilt review state the tab adopts immediately.
export type ResetResult = { state: ReviewState; serverInstanceId?: string }

export const resetReview = async (scope: ResetScope): Promise<ResetResult> => {
	const raw = await api(API_PATHS.reset, {
		method: 'POST',
		body: JSON.stringify({ scope }),
	})
	const o = assertObject(raw, API_PATHS.reset)
	// The reset endpoint answers `{ ok, state, serverInstanceId }` - the rebuilt review
	// lives under `state`, not at the top level.
	if (!requiredBoolean(o, 'ok', API_PATHS.reset))
		throw new DecodeError('acknowledgement ok is false', API_PATHS.reset)
	return {
		state: decodeReviewState(o.state, API_PATHS.reset),
		serverInstanceId: optString(o, 'serverInstanceId', API_PATHS.reset),
	}
}

// Stop the desk (browser Close). An unreachable desk resolves like a shutdown.
export const shutdownDesk = async (): Promise<void> => {
	decodeAck(
		await api(API_PATHS.shutdown, { method: 'POST' }),
		API_PATHS.shutdown,
	)
}

// Long-poll the desk for queued agent events (see app/poll.ts): the hash/guide/comments
// tick with desk liveness, or a refresh event after a same-origin restart.
export const fetchPoll = async (
	query: string,
): Promise<(DeskPollSnapshot & DeskStatus) | DeskRefreshEvent> => {
	const endpoint = `${API_PATHS.poll}${query}`
	const raw = await api(endpoint)
	return decodePollPayload(raw, endpoint)
}

// The full browser review snapshot (adopted as S.state after liveness is stripped).
export const fetchState = async (): Promise<DeskStateSnapshot> => {
	const raw = await api(API_PATHS.state)
	return decodeDeskStateSnapshot(raw, API_PATHS.state)
}
