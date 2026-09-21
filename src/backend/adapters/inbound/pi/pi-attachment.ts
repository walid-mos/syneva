import { correspondentIo } from './correspondent.js'
import { connectDesk, receiveDeskEvent } from './desk-connection.js'
import { startDeskListener } from './desk-listener.js'
import { handleQuestionEvent, wakeDeskOwner } from './pi-delivery.js'
import { correspondentSessionFile } from './pi-thread.js'

import type {
	ExtensionAPI,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import type { CorrespondentIo } from './correspondent.js'
import type { DeskConnection, DeskTarget } from './desk-connection.js'

const ATTACHMENT_ENTRY = 'syneva-attachment'
// A teardown is a best-effort handshake, never a lock: a correspondent that ignores its abort, or a
// socket that never closes, must not be able to hold a tool call (or the human's Escape) open. The
// detach that wedged a session for over an hour had no bound at all.
const TEARDOWN_TIMEOUT_MS = 3_000

type SavedEntry = { type: string; customType?: string; data?: unknown }

// Resolve when the teardown work settles, when the caller aborts, or after the bound - whichever
// comes first. `allSettled` never rejects, so the losing promise is left to finish in peace.
async function awaitBounded(
	work: Promise<unknown>,
	signal?: AbortSignal,
): Promise<void> {
	const limit = signal
		? AbortSignal.any([signal, AbortSignal.timeout(TEARDOWN_TIMEOUT_MS)])
		: AbortSignal.timeout(TEARDOWN_TIMEOUT_MS)
	if (limit.aborted) return
	await Promise.race([
		work,
		new Promise<void>(resolve =>
			limit.addEventListener('abort', () => resolve(), { once: true }),
		),
	])
}
export type AttachmentContext = {
	mode: ExtensionContext['mode']
	sessionManager: { getSessionId(): string; getEntries(): SavedEntry[] }
	ui: Pick<ExtensionContext['ui'], 'notify'>
}

// Forked children must never inherit their parent's listener. All entries are
// read, not just the active branch: tree navigation cannot undo a detach.
export function savedAttachment(
	entries: SavedEntry[],
	owner: string,
): DeskTarget | undefined {
	const entry = entries.findLast(
		record =>
			record.type === 'custom' && record.customType === ATTACHMENT_ENTRY,
	)
	const saved = entry?.data
	if (
		!saved ||
		typeof saved !== 'object' ||
		!('owner' in saved) ||
		saved.owner !== owner ||
		!('target' in saved)
	)
		return undefined
	const { target } = saved
	if (
		!target ||
		typeof target !== 'object' ||
		!('repo' in target) ||
		!('session' in target)
	)
		return undefined
	if (typeof target.repo !== 'string' || typeof target.session !== 'string')
		return undefined
	return { repo: target.repo, session: target.session }
}

// One resource per owning Pi session, independent of agent_end. Pi alone schedules
// model turns; this adapter never spawns a model turn for itself - the only thing it
// spawns is the desk correspondent's thread, and only after a question event.
export class PiDeskAttachment {
	private connection?: DeskConnection
	private controller?: AbortController
	private pending: Promise<void> = Promise.resolve()
	private answerJobs: { desk: DeskConnection; eventPath: string }[] = []
	private answerWorker?: Promise<void>
	private failure?: string
	private generation = 0
	private isConnecting = false

	constructor(
		private readonly pi: Pick<ExtensionAPI, 'sendMessage' | 'appendEntry'>,
		private readonly io: CorrespondentIo = correspondentIo,
	) {}

	isConnected(): boolean {
		return !!this.connection && !this.failure
	}

	describe(): string {
		if (this.failure) return `Disconnected: ${this.failure}`
		if (!this.connection) return 'No Syneva attachment.'
		return `Listening: ${this.connection.repo} / ${this.connection.session}`
	}

	// Exposed for verification: the correspondent thread is keyed by the desk session
	// alone, so every answer of an attachment lands in the same conversation file.
	threadFile(): string | undefined {
		const desk = this.connection
		if (!desk) return undefined
		return correspondentSessionFile(desk)
	}

	async stop(signal?: AbortSignal): Promise<void> {
		await this.teardown(false, signal)
	}

	// Abort first, then wait for what the abort releases - bounded, because both waits are on work
	// this call does not control.
	//
	// The listener is awaited only when the caller is NOT the listener. A `closed` event tears the
	// attachment down from inside this.pending, and awaiting this.pending from there is a promise
	// waiting on itself: the listener held the review's last event, the tool call held the listener,
	// and no abort signal reached either of them (observed: a detach that never returned).
	private async teardown(
		isListenerCaller: boolean,
		signal?: AbortSignal,
	): Promise<void> {
		this.generation++
		this.controller?.abort()
		const waits: Promise<unknown>[] = []
		if (this.answerWorker) waits.push(this.answerWorker)
		if (!isListenerCaller) waits.push(this.pending)
		await awaitBounded(Promise.allSettled(waits), signal)
		this.controller = undefined
		this.connection = undefined
		// Whatever the aborted listener is still doing - a socket that has not closed yet - is no
		// longer this attachment's promise: the next detach or attach must not inherit the wait.
		this.pending = Promise.resolve()
	}

	async detach(ctx: AttachmentContext, signal?: AbortSignal): Promise<void> {
		await this.stop(signal)
		this.failure = undefined
		this.remember(ctx)
	}

	async restore(ctx: AttachmentContext): Promise<void> {
		const target = savedAttachment(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getSessionId(),
		)
		if (!target) return
		try {
			await this.attach(target, ctx)
		} catch (error) {
			this.reportFailure(error, ctx)
		}
	}

	async attach(target: DeskTarget, ctx: AttachmentContext): Promise<void> {
		this.requireAvailable(ctx)
		this.isConnecting = true
		const attempt = this.generation
		try {
			const desk = await connectDesk(target)
			if (attempt !== this.generation)
				throw new Error(
					'Pi session changed while Syneva was connecting; attachment cancelled.',
				)
			this.remember(ctx, { repo: desk.repo, session: desk.session })
			this.connection = desk
			this.controller = new AbortController()
			this.failure = undefined
			this.pending = this.listen(desk, this.controller.signal, ctx)
		} finally {
			this.isConnecting = false
		}
	}

	private requireAvailable(ctx: AttachmentContext): void {
		if (ctx.mode !== 'tui' && ctx.mode !== 'rpc')
			throw new Error(
				'Attach Syneva from the owning persistent Pi session, not a print/JSON one-shot child.',
			)
		if (this.isConnecting)
			throw new Error('A Syneva attachment is already connecting.')
		if (this.isConnected())
			throw new Error(
				`${this.describe()}. Detach before changing attachments.`,
			)
	}

	private remember(ctx: AttachmentContext, target?: DeskTarget): void {
		this.pi.appendEntry(ATTACHMENT_ENTRY, {
			owner: ctx.sessionManager.getSessionId(),
			target,
		})
	}

	private async listen(
		desk: DeskConnection,
		signal: AbortSignal,
		ctx: AttachmentContext,
	): Promise<void> {
		try {
			await startDeskListener({
				signal,
				receive: abort => receiveDeskEvent(desk, abort),
				deliver: event => this.deliverEvent(desk, event, signal),
			})
		} catch (error) {
			this.reportFailure(error, ctx)
			return
		}
		// The loop only resolves on a `closed` event with the signal still alive (aborts return
		// silently, transport failures throw): the human ended the review from the browser.
		// Detach cleanly - no saved target, no dangling connection, no dead-socket error report.
		if (signal.aborted) return
		this.remember(ctx)
		// NOT this.stop(): this runs inside this.pending, so awaiting the listener here would await the
		// promise currently running. Bounded, and the answer worker is still awaited.
		await this.teardown(true)
		ctx.ui.notify(
			'Syneva review closed by the reviewer - attachment detached.',
			'info',
		)
	}

	// Questions must not block the poll loop (the desk must keep seeing an active agent),
	// and they must run serialized so the one correspondent thread is never concurrent.
	// They queue on a single worker instead; reviews and closed keep the synchronous wake.
	private deliverEvent(
		desk: DeskConnection,
		event: string | { eventPath: string; kind: string },
		signal: AbortSignal,
	): void {
		if (typeof event !== 'string' && event.kind === 'question') {
			this.answerJobs.push({ desk, eventPath: event.eventPath })
			this.answerWorker ??= this.workAnswers(signal)
			return
		}
		wakeDeskOwner(
			this.pi,
			desk,
			typeof event === 'string' ? event : event.eventPath,
		)
	}

	private async workAnswers(signal: AbortSignal): Promise<void> {
		try {
			// Serialized answers are the point: one thread, one answer at a time. The
			// drain returns false on an empty queue, which is what ends the loop.
			let didDrain = true
			while (didDrain) didDrain = await this.drainOneAnswer(signal)
		} finally {
			this.answerWorker = undefined
		}
	}

	private async drainOneAnswer(signal: AbortSignal): Promise<boolean> {
		const next = this.answerJobs.shift()
		if (!next) return false
		await this.answerOne(next.desk, next.eventPath, signal)
		return true
	}

	private async answerOne(
		desk: DeskConnection,
		eventPath: string,
		signal: AbortSignal,
	): Promise<void> {
		// handleQuestionEvent owns the fallback wake; a throw here only means the
		// listener aborted mid-answer, and an aborted attachment answers nobody.
		await handleQuestionEvent({
			pi: this.pi,
			desk,
			eventPath,
			signal,
			io: this.io,
		})
	}

	private reportFailure(error: unknown, ctx: AttachmentContext): void {
		this.failure = error instanceof Error ? error.message : String(error)
		ctx.ui.notify(
			`Syneva disconnected: ${this.failure}. Reattach with syneva_agent.`,
			'error',
		)
	}
}
