import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { API_PATHS } from '../../../../contracts/routes.js'
import { sanitizeSession } from '../../../domain/identity.js'
import { readDeskLock, reviewDir } from '../../outbound/filesystem/desk.js'
import { resolveRoot } from '../cli/args.js'

export type DeskTarget = { repo: string; session: string }
export type DeskConnection = DeskTarget & { url: string; directory: string }
const CONNECT_TIMEOUT_MS = 5000
const HOLD_SECONDS = 300
const HOLD_TIMEOUT_MS = 310_000
const NO_CONTENT = 204

// Only local desks are attachment targets. Refuse redirects too: a stale or edited
// lock must never turn this background listener into a request to a remote host.
export function localDeskUrl(lockUrl: string): URL {
	const url = new URL(lockUrl)
	if (
		url.protocol !== 'http:' ||
		!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
		url.username ||
		url.password
	)
		throw new Error('Syneva attachment requires a loopback HTTP desk URL.')
	return url
}

export async function connectDesk(target: DeskTarget): Promise<DeskConnection> {
	const repo = await resolveRoot({ repo: target.repo })
	const session = sanitizeSession(target.session)
	const lock = await readDeskLock(repo, session)
	if (!lock)
		throw new Error(
			`No Syneva desk for ${repo} / ${session}. Start the desk first.`,
		)
	const url = localDeskUrl(lock.url)
	const response = await fetch(new URL(API_PATHS.poll, url), {
		signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
		redirect: 'error',
	})
	if (!response.ok)
		throw new Error(`Syneva attachment failed: HTTP ${response.status}.`)
	const poll: unknown = await response.json()
	if (
		!poll ||
		typeof poll !== 'object' ||
		!('agentListening' in poll) ||
		typeof poll.agentListening !== 'boolean'
	)
		throw new Error(
			'The desk did not return Syneva agent status. Restart or update it.',
		)
	if (poll.agentListening)
		throw new Error(
			'An agent is already listening to this desk. Detach it before attaching another session.',
		)
	return {
		repo,
		session,
		url: url.href,
		directory: await reviewDir(repo, session),
	}
}

// Save every received envelope before notifying Pi. Large reviews are delivered as
// a file reference rather than truncated JSON; a failed wake still leaves evidence.
// Returns the written event's path AND kind, or '' when the long-poll timed out (the
// caller rearms). `closed` tells the attachment the human ended the review.
export async function receiveDeskEvent(
	connection: DeskConnection,
	signal: AbortSignal,
): Promise<string | { eventPath: string; kind: string }> {
	const response = await fetch(
		new URL(
			`${API_PATHS.awaitSend}?timeout=${HOLD_SECONDS}`,
			connection.url,
		),
		{
			signal: AbortSignal.any([
				signal,
				AbortSignal.timeout(HOLD_TIMEOUT_MS),
			]),
			redirect: 'error',
		},
	)
	if (response.status === NO_CONTENT) return ''
	if (!response.ok)
		throw new Error(`Syneva listener failed: HTTP ${response.status}.`)
	const envelope: unknown = await response.json()
	const kind =
		typeof envelope === 'object' && envelope !== null && 'kind' in envelope
			? String(envelope.kind)
			: ''
	if (!['question', 'review', 'closed'].includes(kind))
		throw new Error('Syneva returned an invalid event envelope.')
	const eventPath = path.join(
		connection.directory,
		`pi-event-${randomUUID()}.json`,
	)
	await writeFile(eventPath, JSON.stringify(envelope), { mode: 0o600 })
	return { eventPath, kind }
}
