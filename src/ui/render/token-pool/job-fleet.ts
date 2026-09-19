import { perfMark } from '../../perf'

import { listenToWorker } from './worker-router'

import type { ThemeRegistrationResolved } from '@pierre/diffs'
import type { WorkerRenderingOptions } from '@pierre/diffs/worker'
// Worker slots + message transport for the token pool: boots the module workers, routes every
// reply exactly once (control round trips resolve their awaited promise; window successes and
// failures forward to the JobBook after releasing the slot), and parks tasks with the LPT drain
// in the book. Job scheduling lives in job-board.ts.
import type { JobBoard } from './job-board'
import type { SlotView } from './job-types'
import type { WorkerRequest, WorkerResponse } from './protocol'

class WorkerSlot {
	readonly worker: Worker
	readonly openCacheKeys = new Set<string>()
	// Grammar names this worker already holds (see job-board's attachLanguages).
	readonly attachedLanguages = new Set<string>()
	busy = false

	constructor(workerFactory: () => Worker) {
		this.worker = workerFactory()
	}

	markBusy(): void {
		this.busy = true
	}

	release(): void {
		this.busy = false
	}
}

export const DEFAULT_POOL_SIZE = 4

// Distributed Omit keeps each control request's own shape (a plain Omit over the union
// collapses to the common keys and drops resolvedLanguages from initialize).
//
// Baggage messages (open-diff, attach-languages) ride the SAME registry as control round trips:
// they are posted while the slot is busy running a window, and an unregistered ack would look
// like a free slot to `forwardControl`, releasing a worker that is still tokenizing. That would
// make the drain pile every later window onto the first idle-looking worker - one worker
// serializing the whole plan instead of four running in parallel.
type ControlRequest =
	| Omit<Extract<WorkerRequest, { type: 'initialize' }>, 'id'>
	| Omit<Extract<WorkerRequest, { type: 'set-render-options' }>, 'id'>
	| Omit<Extract<WorkerRequest, { type: 'open-diff' }>, 'id'>
	| Omit<Extract<WorkerRequest, { type: 'attach-languages' }>, 'id'>

export class TokenFleet {
	private slots: WorkerSlot[] = []
	private board: JobBoard | undefined
	// taskId -> awaited control round trip (window tasks live in the JobBook's registry).
	private waiting = new Map<
		string,
		{ accept: (response: WorkerResponse) => void }
	>()
	private nextTransportId = 0

	constructor(
		private workerFactory: () => Worker,
		private poolSize: number = DEFAULT_POOL_SIZE,
	) {}

	// Wire routing exactly once per slot, then await one initialize ack per worker. The board
	// reference is kept for window routing; the manager holds the boot promise and its guard.
	async spawnWorkers(handoff: {
		board: JobBoard
		initialOptions: WorkerRenderingOptions
		themes: ThemeRegistrationResolved[]
	}): Promise<void> {
		this.board = handoff.board
		this.slots = Array.from(
			{ length: this.poolSize },
			() => new WorkerSlot(this.workerFactory),
		)
		for (const slot of this.slots)
			listenToWorker(slot.worker, {
				onControl: (_worker, taskId, response) =>
					this.forwardControl(slot, taskId, response),
				onWindowSuccess: (_worker, response) => {
					slot.release()
					handoff.board.handleWindow(response)
					handoff.board.drain()
				},
				onWindowFailure: (_worker, taskId, failure) => {
					slot.release()
					handoff.board.onWindowFailure(taskId, failure)
					handoff.board.drain()
				},
				onWorkerError: error => {
					slot.release()
					console.error('diff-token worker crashed:', error.message)
				},
			})
		await Promise.all(
			this.slots.map((slot, index) => {
				const started = performance.now()
				return this.initializeSlot(
					slot,
					handoff.initialOptions,
					handoff.themes,
				).then(() =>
					perfMark('pool:worker:ready', {
						slot: index,
						ms: Math.round(performance.now() - started),
					}),
				)
			}),
		)
	}

	async adoptOptions(
		renderOptions: WorkerRenderingOptions,
		themes: ThemeRegistrationResolved[],
	): Promise<void> {
		await Promise.all(
			this.slots.map(slot =>
				this.postControl(slot, {
					type: 'set-render-options',
					renderOptions,
					resolvedThemes: themes,
				}),
			),
		)
	}

	terminateWorkers(): void {
		for (const slot of this.slots) slot.worker.terminate()
		this.slots = []
	}

	// The idle-slot view the book schedules through: grant = mark busy (the free happens on the
	// response routing), so at most one token task parks on a slot at any time. `send` carries
	// baggage messages through the same registry as control round trips, so their acks never
	// release the slot underneath a running window.
	grantIdleSlot(): SlotView | undefined {
		const slot = this.slots.find(worker => !worker.busy)
		if (!slot) return undefined
		slot.markBusy()
		return {
			worker: slot.worker,
			openCacheKeys: slot.openCacheKeys,
			attachedLanguages: slot.attachedLanguages,
			send: request => void this.postControl(slot, request),
		}
	}

	spawnedSlots(): number {
		return this.slots.length
	}

	statsFleetShape(): { totalSlots: number } {
		return { totalSlots: this.slots.length }
	}

	private forwardControl(
		slot: WorkerSlot,
		taskId: string,
		response: WorkerResponse,
	): void {
		const entry = this.waiting.get(taskId)
		if (entry) {
			this.waiting.delete(taskId)
			entry.accept(response)
			return
		}
		// Window failures route through the router's own onWindowFailure path, never here
		// (open-diff acks carry no awaited entry and just pass).
		slot.release()
	}

	private initializeSlot(
		slot: WorkerSlot,
		initialOptions: WorkerRenderingOptions,
		themes: ThemeRegistrationResolved[],
	): Promise<void> {
		return this.postControl(slot, {
			type: 'initialize',
			renderOptions: initialOptions,
			resolvedThemes: themes,
			resolvedLanguages: [],
		})
	}

	private postControl(
		slot: WorkerSlot,
		request: ControlRequest,
	): Promise<void> {
		const id = `tok_${++this.nextTransportId}`
		return new Promise(resolve => {
			this.waiting.set(id, {
				accept: response => {
					if (response.type === 'error')
						console.error(
							'token worker control task failed:',
							response.error,
						)
					resolve()
				},
			})
			slot.worker.postMessage({ ...request, id })
		})
	}
}
