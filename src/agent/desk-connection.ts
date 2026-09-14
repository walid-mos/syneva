import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveRoot } from '../cli/args.js'
import { readDeskLock, reviewDir } from '../state/desk.js'
import { sanitizeSession } from '../state/identity.js'

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
		throw new Error('Galley attachment requires a loopback HTTP desk URL.')
	return url
}

export async function connectDesk(target: DeskTarget): Promise<DeskConnection> {
	const repo = await resolveRoot({ repo: target.repo })
	const session = sanitizeSession(target.session)
	const lock = await readDeskLock(repo, session)
	if (!lock)
		throw new Error(
			`No Galley desk for ${repo} / ${session}. Start the desk first.`,
		)
	const url = localDeskUrl(lock.url)
	const response = await fetch(new URL('/api/poll', url), {
		signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
		redirect: 'error',
	})
	if (!response.ok)
		throw new Error(`Galley attachment failed: HTTP ${response.status}.`)
	const poll: unknown = await response.json()
	if (
		!poll ||
		typeof poll !== 'object' ||
		!('agentListening' in poll) ||
		typeof poll.agentListening !== 'boolean'
	)
		throw new Error(
			'The desk did not return Galley agent status. Restart or update it.',
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
export async function receiveDeskEvent(
	connection: DeskConnection,
	signal: AbortSignal,
): Promise<string> {
	const response = await fetch(
		new URL(`/api/await-send?timeout=${HOLD_SECONDS}`, connection.url),
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
		throw new Error(`Galley listener failed: HTTP ${response.status}.`)
	const envelope: unknown = await response.json()
	if (
		!envelope ||
		typeof envelope !== 'object' ||
		!('kind' in envelope) ||
		!['question', 'review'].includes(String(envelope.kind))
	)
		throw new Error('Galley returned an invalid event envelope.')
	const eventPath = path.join(
		connection.directory,
		`pi-event-${randomUUID()}.json`,
	)
	await writeFile(eventPath, JSON.stringify(envelope), { mode: 0o600 })
	return eventPath
}
