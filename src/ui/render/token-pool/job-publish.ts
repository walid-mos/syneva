import { perfMark, perfSpan } from '../../perf'

import type { GridCaches } from './grid-caches'
import type { TaskEntry, TokenJob } from './job-types'
import type { WorkerResponse, WorkerTokenWindowSuccess } from './protocol'
import type { WindowSpec } from './windows'

// The merge-and-publish half of the job book (scheduling lives in job-board.ts): a landed window
// folds its token rows into the job's grid and the merged result reaches @pierre's renderers on the
// next animation frame, with the LAST landed window shipping the highlighted final that caches.
//
// It needs the same three registries the scheduler owns - open jobs, in-flight tasks, resolved
// grids - so it takes them by reference instead of copying state across the seam.
export class PublishBook {
	constructor(
		private jobs: Map<string, TokenJob>,
		private tasks: Map<string, TaskEntry>,
		private caches: GridCaches,
	) {}

	// The fleet releases the slot before forwarding either path. A landed window merges its rows
	// into the grids; a failed one keeps its plain rows and the countdown continues.
	handleWindow(response: WorkerTokenWindowSuccess): void {
		const { job, spec, entry } = this.settle(response.id)
		if (!job || !spec) return
		const endSpan = perfSpan('pool:merge')
		job.merged.mergeWindow(spec, {
			code: response.code,
			positions: response.positions,
		})
		endSpan({ kind: spec.kind, key: job.cacheKey })
		perfMark('pool:window:done', {
			key: job.cacheKey,
			ms: entry ? Math.round(performance.now() - entry.sentAt) : -1,
			kind: spec.kind,
			line: spec.startingLine,
			...response.timings,
		})
		this.markLanded(job, spec)
	}

	onWindowFailure(taskId: string, response: WorkerResponse): void {
		const { job, spec } = this.settle(taskId)
		if (!job || !spec) return
		console.error('token window task failed:', response)
		this.markLanded(job, spec)
	}

	// A response only counts when its task is still registered AND still marked sent: a duplicate,
	// a reply from a job that was invalidated, or one racing a re-dispatch must not merge rows or
	// decrement the countdown twice.
	private settle(taskId: string): {
		job: TokenJob | undefined
		spec: WindowSpec | undefined
		entry: TaskEntry | undefined
	} {
		const entry = this.tasks.get(taskId)
		this.tasks.delete(taskId)
		const job = entry && this.jobs.get(entry.jobKey)
		const task = job?.windows.find(
			windowTask => windowTask.spec === entry?.spec,
		)
		const landed = task?.status === 'sent'
		return {
			job: landed ? job : undefined,
			spec: landed ? task.spec : undefined,
			entry,
		}
	}

	private markLanded(job: TokenJob, spec: WindowSpec): void {
		const landed: TokenJob = {
			...rerank(job, spec, 'done'),
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
		perfMark('pool:final')
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
		// The renderer re-renders synchronously inside this loop; timing it tells a slow publish
		// (row rebuild) apart from a slow tokenization (worker work).
		const endSpan = perfSpan(
			isHighlighted ? 'pool:publish:final' : 'pool:publish',
		)
		for (const instance of job.instances)
			instance.onHighlightSuccess(
				job.diff,
				job.merged.result(),
				job.options,
				isHighlighted,
			)
		endSpan({
			key: job.cacheKey,
			landed: job.windows.filter(task => task.status === 'done').length,
			total: job.windows.length,
			windows: job.windows.length,
			lines: job.diff.splitLineCount,
		})
	}
}

// Completion replaces a job's window list (no argument mutation): the scheduler and the publisher
// both transition a window's status through this one place.
export function rerank(
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
