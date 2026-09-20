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
	// Set by JobBoard post-construction (one owner of the maps, no copies): every publish, with or
	// without instances, is first-colour bookkeeping for the cold-open reveal hold.
	onPublish: ((cacheKey: string) => void) | undefined
	constructor(
		private jobs: Map<string, TokenJob>,
		private tasks: Map<string, TaskEntry>,
		private caches: GridCaches,
	) {}

	// The first publish after this many windows have merged carries highlighted=true: @pierre's
	// renderer repaints ONLY from a highlighted publish (every partial grid gets overwritten by the
	// plain rows of its next converge pass), and waiting for the whole file to finish put color
	// minutes away on big diffs - or never, when the reviewer never scrolls through every line. The
	// plan dispatches nearest the viewport first and one window holds 192 rows (≈ 2-3 viewports), so
	// two merged windows all but guarantee the visible band is tokenized. The merged grid always
	// covers every row (plain where tokens have not landed), so a partial highlighted grid is safe
	// to paint; later merges spread color through the renderer's own scroll-driven passes.
	private static readonly BAND_PUBLISH_WINDOWS = 2
	// A window that never answers must not hold the countdown open forever: the whole-file final
	// (which settles the result cache) only fires at remaining === 0. Swept passively on every
	// landing - no timers, nothing to clean up - and stale tasks resolve as failures: their rows
	// stay plain, the countdown continues.
	private static readonly WINDOW_TIMEOUT_MS = 30_000
	private sweepStale(): void {
		const now = performance.now()
		const stale: string[] = []
		for (const [taskId, entry] of this.tasks)
			if (now - entry.sentAt > PublishBook.WINDOW_TIMEOUT_MS)
				stale.push(taskId)
		for (const taskId of stale)
			this.onWindowFailure(taskId, {
				type: 'error',
				id: taskId,
				error: 'token window timed out',
			})
	}

	// The fleet releases the slot before forwarding either path. A landed window merges its rows
	// into the grids; a failed one keeps its plain rows and the countdown continues.
	handleWindow(response: WorkerTokenWindowSuccess): void {
		this.sweepStale()
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
		// Sticky flip: once the band publish fired, every publish after it carries highlighted=true,
		// so @pierre's renderCache keeps the freshest merged grid instead of refetching plain rows.
		const published: TokenJob = {
			...landed,
			highlighted:
				landed.highlighted === true || this.bandSettled(landed),
		}
		this.jobs.set(job.cacheKey, published)
		if (published.remaining === 0) {
			this.settleJob(published)
			return
		}
		this.schedulePublish(published)
	}

	// The whole-file countdown reached zero: cache the fully merged grid as the settled result and
	// publish it highlighted (stops @pierre's converge loop and settles the cache).
	private settleJob(job: TokenJob): void {
		this.jobs.delete(job.cacheKey)
		this.caches.cacheFinal(job.cacheKey, {
			result: job.merged.result(),
			options: job.options,
		})
		this.notify(job, true)
		perfMark('pool:final')
	}

	private bandSettled(job: TokenJob): boolean {
		return (
			job.windows.filter(task => task.status === 'done').length >=
			PublishBook.BAND_PUBLISH_WINDOWS
		)
	}

	// One merged grid per publish. A partial publish repaints the converge loop (it keeps asking);
	// the highlighted one (band merged or whole file) is the one that actually paints color. The
	// frame reads the CURRENT job so a sticky flip that lands mid-frame is never published stale.
	private schedulePublish(job: TokenJob): void {
		if (job.publishFrame) return
		const frame = requestAnimationFrame(() => {
			const current = this.jobs.get(job.cacheKey)
			if (!current) return
			this.jobs.set(job.cacheKey, { ...current, publishFrame: undefined })
			this.notify(current, current.highlighted === true)
		})
		this.jobs.set(job.cacheKey, { ...job, publishFrame: frame })
	}

	private notify(job: TokenJob, isHighlighted: boolean): void {
		// An instance-less publish has nobody to repaint: stash the merged grid so the renderer that
		// mounts later adopts the colored rows as its plain rows (the load-anyway reveal then paints
		// colored instead of a grey flash) instead of dropping the work until shipFinal. The stash is
		// the mount's own merge skeleton slot, so a later window just merges over it.
		if (job.instances.size === 0)
			this.caches.stashSkeleton(job.cacheKey, job.merged.result())
		this.onPublish?.(job.cacheKey)
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
