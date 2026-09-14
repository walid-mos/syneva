import { connectDesk, receiveDeskEvent } from './desk-connection.js'
import { startDeskListener } from './desk-listener.js'

import type {
	ExtensionAPI,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import type { DeskConnection, DeskTarget } from './desk-connection.js'

const ATTACHMENT_ENTRY = 'galley-attachment'
type SavedEntry = { type: string; customType?: string; data?: unknown }

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

export function wakeDeskOwner(
	pi: Pick<ExtensionAPI, 'sendMessage'>,
	target: DeskTarget,
	eventPath: string,
): void {
	pi.sendMessage(
		{
			customType: 'galley-event',
			content: `Galley feedback for repo ${JSON.stringify(target.repo)}, session ${JSON.stringify(target.session)}.\nRead the complete event at ${JSON.stringify(eventPath)} and follow galley spec (read it once per session). Answer every question via galley comment; act on review events and reload the desk. Always pass this repo and session to Galley CLI commands.\nThe native listener stays attached across turns. Do not launch galley await, a polling child, or another agent to wait. Return control after handling feedback; further events wake this session automatically.`,
			display: true,
			details: { ...target, eventPath },
		},
		{ triggerTurn: true, deliverAs: 'followUp' },
	)
}

// One resource per owning Pi session, independent of agent_end. Pi alone schedules
// model turns; this adapter never spawns a model or a waiting subprocess.
export class PiDeskAttachment {
	private connection?: DeskConnection
	private controller?: AbortController
	private pending = Promise.resolve()
	private failure?: string
	private generation = 0
	private isConnecting = false

	constructor(
		private readonly pi: Pick<ExtensionAPI, 'sendMessage' | 'appendEntry'>,
	) {}

	isConnected(): boolean {
		return !!this.connection && !this.failure
	}

	describe(): string {
		if (this.failure) return `Disconnected: ${this.failure}`
		if (!this.connection) return 'No Galley attachment.'
		return `Listening: ${this.connection.repo} / ${this.connection.session}`
	}

	async stop(): Promise<void> {
		this.generation++
		this.controller?.abort()
		await this.pending
		this.controller = undefined
		this.connection = undefined
	}

	async detach(ctx: ExtensionContext): Promise<void> {
		await this.stop()
		this.failure = undefined
		this.remember(ctx)
	}

	async restore(ctx: ExtensionContext): Promise<void> {
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

	async attach(target: DeskTarget, ctx: ExtensionContext): Promise<void> {
		this.requireAvailable(ctx)
		this.isConnecting = true
		const attempt = this.generation
		try {
			const desk = await connectDesk(target)
			if (attempt !== this.generation)
				throw new Error(
					'Pi session changed while Galley was connecting; attachment cancelled.',
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

	private requireAvailable(ctx: ExtensionContext): void {
		if (ctx.mode !== 'tui' && ctx.mode !== 'rpc')
			throw new Error(
				'Attach Galley from the owning persistent Pi session, not a print/JSON one-shot child.',
			)
		if (this.isConnecting)
			throw new Error('A Galley attachment is already connecting.')
		if (this.isConnected())
			throw new Error(
				`${this.describe()}. Detach before changing attachments.`,
			)
	}

	private remember(ctx: ExtensionContext, target?: DeskTarget): void {
		this.pi.appendEntry(ATTACHMENT_ENTRY, {
			owner: ctx.sessionManager.getSessionId(),
			target,
		})
	}

	private async listen(
		desk: DeskConnection,
		signal: AbortSignal,
		ctx: ExtensionContext,
	): Promise<void> {
		try {
			await startDeskListener({
				signal,
				receive: abort => receiveDeskEvent(desk, abort),
				deliver: eventPath => wakeDeskOwner(this.pi, desk, eventPath),
			})
		} catch (error) {
			this.reportFailure(error, ctx)
		}
	}

	private reportFailure(error: unknown, ctx: ExtensionContext): void {
		this.failure = error instanceof Error ? error.message : String(error)
		ctx.ui.notify(
			`Galley disconnected: ${this.failure}. Reattach with galley_agent.`,
			'error',
		)
	}
}
