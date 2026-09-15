import { GridCaches } from './grid-caches'
// Job book for the token pool: open jobs keyed by diff cacheKey, the window task registry,
// the result/skeleton caches, window merges, and the rAF-coalesced publishes to @pierre
// renderers (slots + transport in job-fleet.ts). Completion REPLACES a job's window list and
// remaining count (no argument mutation).
import { createSkeleton, MergeGrid } from './merge'
import { renderPlainResult, resolveLanguagesFor } from './plain'
import { planByCost, planTokenWindows } from './windows'

import type { FileDiffMetadata, ThemedDiffResult } from '@pierre/diffs'
import type {
	ResolvedLanguage,
	WorkerRenderingOptions,
} from '@pierre/diffs/worker'
import type { GridFinal } from './grid-caches'
import type {
	WorkerRequest,
	WorkerResponse,
	WorkerTokenWindowSuccess,
} from './protocol'
import type { WindowSpec } from './windows'

export type PublishRenderer = {
	onHighlightSuccess: (
		diff: FileDiffMetadata,
		result: ThemedDiffResult,
		options: WorkerRenderingOptions,
		highlighted?: boolean,
	) => void
}

type WindowTask = { spec: WindowSpec; status: 'queued' | 'sent' | 'done' }

type TokenJob = {
	cacheKey: string
	diff: FileDiffMetadata
	options: WorkerRenderingOptions
	// The merge target (full plain skeleton + progressive token rows).
	merged: MergeGrid
	windows: WindowTask[]
	remaining: number
	instances: Set<PublishRenderer>
	languages: ResolvedLanguage[] | undefined
	publishFrame: number | undefined
}

// The slot slice the book needs: it never boots or routes, it parks tasks.
export type SlotView = {
	worker: Worker
	openCacheKeys: Set<string>
}

export class JobBoard {
	private idleSlot: () => SlotView | undefined
	private jobs = new Map<string, TokenJob>()
	// taskId -> in-flight window task (failures resolve against it, responses settle).
	private tasks = new Map<string, { jobKey: string; spec: WindowSpec }>()
	private caches = new GridCaches()
	private nextTaskId = 0

	constructor(idleSlot: () => SlotView | undefined) {
		this.idleSlot = idleSlot
	}

	// The fleet re-drains after freeing a slot.
	drain(): void {
		this.drainJobs()
	}

	cachedFinal(cacheKey: string): GridFinal | undefined {
		return this.caches.cachedFinal(cacheKey)
	}

	stashedSkeleton(cacheKey: string): ThemedDiffResult | undefined {
		return this.caches.stashedSkeleton(cacheKey)
	}

	stashSkeleton(cacheKey: string, skeleton: ThemedDiffResult): void {
		this.caches.stashSkeleton(cacheKey, skeleton)
	}

	// Options-scoped invalidation: renderers re-request; stale responses drop.
	invalidate(): void {
		this.jobs.clear()
		this.caches.invalidate()
	}

	statsShape(): { activeJobs: number; cacheEntries: number } {
		return { activeJobs: this.jobs.size, ...this.caches.statsShape() }
	}

	// Attach/detach renderers to the open job (dedupe across @pierre's converge loop).
	jobOpen(cacheKey: string): boolean {
		return this.jobs.has(cacheKey)
	}

	attachInstance(
		instance: PublishRenderer | undefined,
		cacheKey: string,
	): void {
		if (!instance) return
		const job = this.jobs.get(cacheKey)
		job?.instances.add(instance)
	}

	detachInstance(instance: PublishRenderer): void {
		for (const job of this.jobs.values()) job.instances.delete(instance)
	}

	// The renderer's plain rows while tokens are in flight: a full grid superset (@pierre
	// indexes rows by per-side content index, so it serves every range/expansion state).
	servePlainRows(
		diff: FileDiffMetadata,
		options: WorkerRenderingOptions,
	): ThemedDiffResult | undefined {
		if (!diff.cacheKey) return renderPlainResult(diff, options)
		const settled = this.caches.cachedFinal(diff.cacheKey)
		if (settled) return settled.result
		const stashed = this.caches.stashedSkeleton(diff.cacheKey)
		if (stashed) return stashed
		const plain = renderPlainResult(diff, options)
		if (!plain) return undefined
		this.caches.stashSkeleton(diff.cacheKey, plain)
		return plain
	}

	openJob(
		diff: FileDiffMetadata,
		instance: PublishRenderer | undefined,
		options: WorkerRenderingOptions,
	): void {
		if (!diff.cacheKey) return
		// servePlainRows usually stashed the skeleton (the renderer's plain precedes it).
		const skeleton = this.servePlainRows(diff, options)
		if (!skeleton) return
		const plan = planByCost(diff, planTokenWindows(diff))
		this.jobs.set(diff.cacheKey, {
			cacheKey: diff.cacheKey,
			diff,
			options,
			merged: new MergeGrid(createSkeleton(skeleton)),
			windows: plan.map(spec => ({ spec, status: 'queued' })),
			remaining: plan.length,
			instances: instance ? new Set([instance]) : new Set(),
			languages: undefined,
			publishFrame: undefined,
		})
		void this.settleLanguages(diff.cacheKey, diff)
		this.drainJobs()
	}

	// Languages land on whatever job is current at resolve time.
	private async settleLanguages(
		cacheKey: string,
		diff: FileDiffMetadata,
	): Promise<void> {
		const languages = await resolveLanguagesFor(diff)
		const job = this.jobs.get(cacheKey)
		if (!job) return
		this.jobs.set(cacheKey, { ...job, languages })
		this.drainJobs()
	}

	// LPT: windows are pre-sorted longest-first; each parks on an idle slot.
	private drainJobs(): void {
		for (const job of this.jobs.values()) {
			if (!job.languages) continue
			this.dispatchStalled(job)
		}
	}

	private dispatchStalled(job: TokenJob): void {
		for (const task of job.windows) {
			if (task.status !== 'queued') continue
			const slot = this.idleSlot()
			if (!slot) return
			this.dispatchWindow(slot, job, task)
		}
	}

	private dispatchWindow(
		slot: SlotView,
		job: TokenJob,
		task: WindowTask,
	): void {
		// open-diff rides ahead in message order; token tasks settle against their id.
		if (!slot.openCacheKeys.has(job.cacheKey)) {
			slot.openCacheKeys.add(job.cacheKey)
			slot.worker.postMessage({
				type: 'open-diff',
				id: `job_${++this.nextTaskId}`,
				cacheKey: job.cacheKey,
				diff: job.diff,
			} satisfies WorkerRequest)
		}
		const id = `job_${++this.nextTaskId}`
		this.jobs.set(job.cacheKey, this.rerank(job, task.spec, 'sent'))
		this.tasks.set(id, { jobKey: job.cacheKey, spec: task.spec })
		slot.worker.postMessage({
			type: 'token-window',
			id,
			cacheKey: job.cacheKey,
			window: task.spec,
			// Grammar data rides with every dispatch; workers never resolve loaders.
			resolvedLanguages: job.languages ?? [],
		} satisfies WorkerRequest)
	}

	private rerank(
		job: TokenJob,
		spec: WindowSpec,
		status: 'sent' | 'done',
	): TokenJob {
		return {
			...job,
			windows: job.windows.map(task =>
				task.spec === spec ? { ...task, status } : task,
			),
		}
	}

	// The fleet releases the slot before forwarding either path. A landed window merges its
	// rows into the grids; a failed one keeps its plain rows and the countdown continues.
	handleWindow(response: WorkerTokenWindowSuccess): void {
		const { job, spec } = this.settle(response.id)
		if (!job || !spec) return
		job.merged.mergeWindow(spec, {
			code: response.code,
			positions: response.positions,
		})
		this.markLanded(job, spec)
	}

	onWindowFailure(taskId: string, response: WorkerResponse): void {
		const { job, spec } = this.settle(taskId)
		if (!job || !spec) return
		console.error('token window task failed:', response)
		this.markLanded(job, spec)
	}

	private settle(taskId: string): {
		job: TokenJob | undefined
		spec: WindowSpec | undefined
	} {
		const entry = this.tasks.get(taskId)
		this.tasks.delete(taskId)
		const job = entry && this.jobs.get(entry.jobKey)
		const task = job?.windows.find(
			windowTask => windowTask.spec === entry?.spec,
		)
		const settled = task?.status === 'sent'
		return {
			job: settled ? job : undefined,
			spec: settled ? task.spec : undefined,
		}
	}

	private markLanded(job: TokenJob, spec: WindowSpec): void {
		const landed: TokenJob = {
			...this.rerank(job, spec, 'done'),
			remaining: job.remaining - 1,
		}
		this.jobs.set(job.cacheKey, landed)
		if (landed.remaining === 0) this.shipFinal(landed)
		else this.schedulePartialPublish(landed)
	}

	// One merged grid per publish. The final publish (highlighted=true) stops @pierre's
	// converge loop and settles the cache.
	private shipFinal(job: TokenJob): void {
		this.jobs.delete(job.cacheKey)
		this.caches.cacheFinal(job.cacheKey, {
			result: job.merged.result(),
			options: job.options,
		})
		this.notify(job, true)
	}

	private schedulePartialPublish(job: TokenJob): void {
		if (job.publishFrame) return
		const frame = requestAnimationFrame(() => {
			const current = this.jobs.get(job.cacheKey)
			if (!current) return
			this.jobs.set(job.cacheKey, { ...current, publishFrame: undefined })
			this.notify(current, false)
		})
		this.jobs.set(job.cacheKey, { ...job, publishFrame: frame })
	}

	private notify(job: TokenJob, isHighlighted: boolean): void {
		for (const instance of job.instances)
			instance.onHighlightSuccess(
				job.diff,
				job.merged.result(),
				job.options,
				isHighlighted,
			)
	}
}
