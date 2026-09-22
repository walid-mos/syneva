import { unlinkSync } from 'node:fs'

import { appendComment } from '../../../application/comments.js'
import { parseLineNumber } from '../../../domain/comments.js'
import { printJson, warn } from '../../outbound/console.js'
import {
	deskLockPath,
	findLiveDesks,
	isDeskProcessAlive,
	readDeskLock,
	reviewDir,
} from '../../outbound/filesystem/desk.js'
import { nodeReviewStore } from '../../outbound/filesystem/persistence.js'
import { nodeGit } from '../../outbound/git/repo.js'

import { loadGuideArg, resolveActionSession, resolveRoot } from './args.js'
import {
	httpGetJson,
	postJson,
	postReload,
	postShutdown,
	readCommentId,
	readReloadResult,
} from './desk-client.js'

import type { DeskLock } from '../../outbound/filesystem/desk.js'
import type { CliArgs } from './args.js'

type CommentPayload = {
	path: string
	side: 'additions' | 'deletions'
	lineNumber: number
	body: string
	role: 'agent'
}

const COMMENT_USAGE =
	'Usage: syneva comment --path <file> --line <n> [--side additions|deletions] --body "..."\n' +
	'       (--line 0 replies into the file header thread; omit --side there) [--session <id>] [--repo <path>]'
const STATUS_USAGE =
	'Usage: syneva status --body "..." [--session <id>] [--repo <path>]'

// `syneva comment --path <file> --line <n> [--side additions] --body "..."`
// Posts an agent reply. If a live desk is running for the session, it goes over
// HTTP so the open tab updates immediately; otherwise it is appended to the
// saved review for the next time the desk opens.
export async function runComment(args: CliArgs): Promise<void> {
	const root = await resolveRoot(args)
	const session = await resolveActionSession(root, args)
	const payload = parseCommentPayload(args)
	if (!payload) {
		warn(COMMENT_USAGE)
		process.exitCode = 1
		return
	}
	const lock = await readDeskLock(root, session)
	if (lock) {
		const response = await postJson({
			url: `${lock.url}api/comment`,
			payload,
		})
		if (response.ok) {
			printJson({
				ok: true,
				live: true,
				session,
				commentId: readCommentId(response.body),
			})
			return
		}
	}
	const comment = await appendComment(root, session, payload, {
		store: nodeReviewStore,
		git: nodeGit,
	})
	printJson({ ok: true, live: false, session, commentId: comment.id })
}

function parseCommentPayload(args: CliArgs): CommentPayload | null {
	const path = typeof args.path === 'string' ? args.path : ''
	const body = typeof args.body === 'string' ? args.body.trim() : ''
	if (!path || !body) return null
	const side: 'additions' | 'deletions' =
		args.side === 'deletions' ? 'deletions' : 'additions'
	const lineNumber = parseLineNumber(args.line)
	if (lineNumber === null) return null
	return {
		path,
		side,
		lineNumber,
		body,
		role: 'agent',
	}
}

// `syneva status --body "..."` - post an ephemeral "what I'm doing now" line that
// shows next to the reviewer's waiting indicator. Unlike comment there is no
// offline fallback: ephemeral status is meaningless without a live desk, and it
// must never fail the agent loop - no desk just reports { live: false }, exit 0.
export async function runStatus(args: CliArgs): Promise<void> {
	const root = await resolveRoot(args)
	const session = await resolveActionSession(root, args)
	const body = typeof args.body === 'string' ? args.body.trim() : ''
	if (!body) {
		warn(STATUS_USAGE)
		process.exitCode = 1
		return
	}
	const lock = await readDeskLock(root, session)
	if (lock) {
		const response = await postJson({
			url: `${lock.url}api/status`,
			payload: { body },
		})
		if (response.ok) {
			printJson({ ok: true, live: true, session })
			return
		}
	}
	printJson({ ok: false, live: false, session })
}

type StopOutcome =
	| { kind: 'stopped'; session: string }
	| { kind: 'unreachable'; session: string; pid: number }
	| { kind: 'swept'; session: string }

// `syneva stop [--session <id> | --all]` - shut down this repo's live desk(s). Idempotent:
// exit 0 whether or not anything was running, so agents can call it unconditionally when a
// review session ends. Shutdown goes over HTTP (the desk exits after acking, removing its
// own lock) - never a bare kill(pid), which risks PID reuse. A lock whose pid is dead is
// swept; a lock whose pid is alive but whose server won't answer is reported, not killed.
export async function runStop(args: CliArgs): Promise<void> {
	const root = await resolveRoot(args)
	const locks =
		args.all === true
			? await findLiveDesks(root)
			: await sessionLocks(root, args)
	const outcomes = await Promise.all(locks.map(lock => stopDesk(root, lock)))
	const stopped = outcomes
		.filter(outcome => outcome.kind === 'stopped')
		.map(outcome => outcome.session)
	const unreachable = outcomes.flatMap(outcome =>
		outcome.kind === 'unreachable'
			? [{ session: outcome.session, pid: outcome.pid }]
			: [],
	)
	for (const desk of unreachable)
		warn(
			`Desk "${desk.session}" (pid ${desk.pid}) is running but not answering - kill it manually: kill ${desk.pid}`,
		)
	printJson({ ok: true, stopped, unreachable })
}

async function sessionLocks(root: string, args: CliArgs): Promise<DeskLock[]> {
	const session = await resolveActionSession(root, args)
	const lock = await readDeskLock(root, session)
	return lock ? [lock] : []
}

async function stopDesk(root: string, lock: DeskLock): Promise<StopOutcome> {
	const response = await postShutdown(lock.url)
	if (response.ok) return { kind: 'stopped', session: lock.session }
	if (isDeskProcessAlive(lock.pid))
		return { kind: 'unreachable', session: lock.session, pid: lock.pid }
	unlinkSync(deskLockPath(await reviewDir(root, lock.session)))
	return { kind: 'swept', session: lock.session }
}

// `syneva await --session <id>` - block until the next desk event, then print it
// to stdout as a tagged envelope and exit. The event is either
//   {"kind":"question","question":{path,lineNumber,side,body,mode,session}}  - answer it now
//   {"kind":"review","result":{…ReviewResult…}}                              - the reviewer hit Send
// Call in a loop and branch on `kind`. Answer a question with `syneva comment`.
export async function runAwait(args: CliArgs): Promise<void> {
	const root = await resolveRoot(args)
	const session = await resolveActionSession(root, args)
	const lock = await readDeskLock(root, session)
	if (!lock) {
		warn(
			`No live desk for session "${session}". Start it with: syneva --session ${session}`,
		)
		process.exitCode = 1
		return
	}
	const response = await httpGetJson(awaitUrl(lock.url, args))
	if (response.status === NO_CONTENT || !response.body) {
		// A timed-out wait (204) leaves the loop alive; a dead/unreachable desk must NOT
		// return empty-and-0, or the spec's `while ev=$(syneva await)` loop would spin
		// against a corpse - exit non-zero so the caller re-checks liveness instead.
		if (response.status !== NO_CONTENT) {
			warn(
				`Desk for session "${session}" is not answering (closed or stopped? ${lock.url})`,
			)
			process.exitCode = 1
		}
		return
	}
	// `unknown` on purpose: the guard above narrows response.body to a truthy value, which
	// would make the object/kind checks below look redundant to the type checker.
	const event: unknown = response.body
	if (typeof event === 'object' && event !== null && 'kind' in event)
		printJson(event)
}

const NO_CONTENT = 204

function awaitUrl(deskUrl: string, args: CliArgs): string {
	const base = `${deskUrl}api/await-send`
	const timeout = typeof args.timeout === 'string' ? Number(args.timeout) : 0
	return timeout > 0 ? `${base}?timeout=${timeout}` : base
}

// `syneva reload --session <id> [--guide <file>]` - re-diff the working tree into the
// live desk so the agent's edits show up in the open tab without a restart; --guide
// swaps the attached review guide in the same round-trip.
export async function runReload(args: CliArgs): Promise<void> {
	const root = await resolveRoot(args)
	const session = await resolveActionSession(root, args)
	const lock = await readDeskLock(root, session)
	if (!lock) {
		warn(
			`No live desk for session "${session}" to reload. Start it with: syneva --session ${session}`,
		)
		process.exitCode = 1
		return
	}
	const guide = loadGuideArg(args.guide)
	if (guide === null) {
		process.exitCode = 1
		return
	}
	const response = await postReload(lock.url, guide)
	if (!response.ok) {
		warn('Reload failed - is the desk still running?')
		process.exitCode = 1
		return
	}
	const reload = readReloadResult(response.body)
	printJson({
		ok: true,
		live: true,
		session,
		baseDiffHash: reload.baseDiffHash,
		empty: reload.empty,
	})
}
