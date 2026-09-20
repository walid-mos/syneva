import { perfMark } from '../../perf'

import { GridCaches } from './grid-caches'
import { PublishBook } from './job-publish'
import { LanguageBook } from './languages'
import { createSkeleton, MergeGrid } from './merge'
import { WindowDispatch } from './window-dispatch'
import { planWindowOrder, STREAM_LOOKAHEAD_SLOTS } from './windows'

// Job book for the token pool: the open jobs keyed by diff cacheKey, their window task registry, the
// resolved-grid caches, and the wiring of the two collaborators that do the rest - scheduling to the
// workers (window-dispatch.ts) and merge-and-publish back into @pierre (job-publish.ts).
//
// State discipline: a job object is a SNAPSHOT, so every transition re-reads the current entry and
// writes the result back. A walk over a stale job would re-dispatch in-flight windows and
// double-decrement `remaining`, shipping a half-colored grid as the final one.
import type { FileDiffMetadata, ThemedDiffResult } from '@pierre/diffs'
import type { WorkerRenderingOptions } from '@pierre/diffs/worker'
import type { GridFinal } from './grid-caches'
import type {
	PublishRenderer,
	SlotView,
	TaskEntry,
	TokenJob,
} from './job-types'
import type { WorkerResponse, WorkerTokenWindowSuccess } from './protocol'

export class JobBoard {
	private jobs = new Map<string, TokenJob>()
	// taskId -> in-flight window task (failures resolve against it, responses settle).
	private tasks = new Map<string, TaskEntry>()
	private caches = new GridCaches()
	private publisher = new PublishBook(this.jobs, this.tasks, this.caches)
	private dispatch: WindowDispatch

	constructor(
		idleSlot: () => SlotView | undefined,
		private poolSize: number,
	) {
		// Both collaborators take the registries by reference: one owner of the maps, no copies.
		this.dispatch = new WindowDispatch(
			idleSlot,
			this.jobs,
			this.tasks,
			poolSize,
		)
		// The viewport map stays JobBoard-owned; the dispatcher reads it through the gate hook.
		this.dispatch.viewportOf = cacheKey => this.viewports.get(cacheKey)
	}

	// A viewport range arrives on every pass the renderer paints; only the first few are worth a
	// mark, and the cap keeps a long review session's timeline bounded.
	private static readonly VIEWPORT_MARK_CAP = 12

	// The fleet re-drains after freeing a slot.
	// The range @pierre last asked plain rows for: the freshest statement of what the reviewer is
	// looking at, kept per cacheKey so a window plan can put the visible slots first.
	private viewports = new Map<
		string,
		{ startingLine: number; totalLines: number }
	>()
	private rangeMarks = 0

	drain(): void {
		this.dispatch.drain()
	}

	// Called on every pass the renderer asks for plain rows (before it asks for tokens), so a job
	// opened in that same pass already knows where the reviewer is looking.
	noteViewport(
		cacheKey: string | undefined,
		startingLine: number,
		totalLines: number,
	): void {
		if (!cacheKey) return
		const previous = this.viewports.get(cacheKey)
		this.viewports.set(cacheKey, { startingLine, totalLines })
		// A reviewer scrolling into unscheduled slots must move the stream with them: re-drain when
		// the viewport crosses into a new lookahead band. The dispatch itself is a nearest-queued
		// scan over the job's plan, so the re-drain is cheap enough to ride every crossing.
		const band = Math.floor(startingLine / STREAM_LOOKAHEAD_SLOTS)
		if (
			previous &&
			Math.floor(previous.startingLine / STREAM_LOOKAHEAD_SLOTS) !== band
		)
			this.dispatch.drain()
		if (this.rangeMarks < JobBoard.VIEWPORT_MARK_CAP) {
			this.rangeMarks++
			perfMark('pool:range', {
				from: startingLine,
				lines: totalLines,
			})
		}
	}

	// Grammars resolved once per diff, started earlier than the job (languages.ts).
	private languages = new LanguageBook()

	prewarmLanguages(diff: FileDiffMetadata): void {
		this.languages.prewarm(diff)
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

	// The renderer's plain rows while tokens are in flight (cache order in grid-caches.ts).
	servePlainRows(
		diff: FileDiffMetadata,
		options: WorkerRenderingOptions,
	): ThemedDiffResult | undefined {
		return this.caches.plainRows(diff, options)
	}

	// `isWarm` opens a prefetch job: a file the reviewer has NOT opened. It is planned like any job but
	// only dispatched on slots an attached job left free, up to one viewport band (window-dispatch.ts),
	// so the click that finally opens the file finds colored rows in the cache instead of a grey first
	// screen. The plan stays complete: the moment a renderer attaches, the rest streams normally.
	openJob(
		diff: FileDiffMetadata,
		instance: PublishRenderer | undefined,
		options: WorkerRenderingOptions,
		isWarm = false,
	): void {
		if (!diff.cacheKey) return
		// The renderer re-requests around its own repaints; a job that is already open just gains
		// the instance (a second job for the same key would orphan the first one's in-flight work).
		if (this.jobs.has(diff.cacheKey)) {
			this.attachInstance(instance, diff.cacheKey)
			this.drain()
			return
		}
		this.prewarmLanguages(diff)
		// servePlainRows usually stashed the skeleton already (the renderer asks plain first).
		const skeleton = this.servePlainRows(diff, options)
		if (!skeleton) return
		// The reviewer's own view window leads the plan, split across the pool (windows.ts).
		const plan = planWindowOrder(
			diff,
			this.viewports.get(diff.cacheKey),
			this.poolSize,
		)
		perfMark('pool:job:open', {
			key: diff.cacheKey,
			windows: plan.length,
			lines: diff.splitLineCount,
			prefetch: isWarm ? 1 : 0,
		})
		// Known grammars are read synchronously so this open's drain can dispatch for real, in this turn:
		// on a cold open the turn continues into the renderer's first paint (300 ms, measured), and an
		// await here parks the dispatch behind it while four workers sit idle.
		const known = this.languages.settled(diff.cacheKey)
		this.jobs.set(diff.cacheKey, {
			cacheKey: diff.cacheKey,
			diff,
			options,
			merged: new MergeGrid(createSkeleton(skeleton)),
			windows: plan.map(spec => ({ spec, status: 'queued' })),
			remaining: plan.length,
			instances: instance ? new Set([instance]) : new Set(),
			languages: known,
			publishFrame: undefined,
			isWarm,
		})
		if (known) this.dispatch.drain()
		else void this.settleLanguages(diff.cacheKey)
	}

	// Only for grammars that were still resolving when the job opened: they land on the job and drain
	// the moment they arrive.
	private async settleLanguages(cacheKey: string): Promise<void> {
		const pending = this.languages.pending(cacheKey)
		if (!pending) return
		const languages = await pending
		const job = this.jobs.get(cacheKey)
		if (!job || job.languages) return
		this.jobs.set(cacheKey, { ...job, languages })
		this.dispatch.drain()
	}

	// Merge + publish live in job-publish.ts (the scheduler above owns dispatch order).
	handleWindow(response: WorkerTokenWindowSuccess): void {
		this.publisher.handleWindow(response)
	}

	onWindowFailure(taskId: string, response: WorkerResponse): void {
		this.publisher.onWindowFailure(taskId, response)
	}
}
