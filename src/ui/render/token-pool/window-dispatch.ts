import { perfMark, perfSpan } from '../../perf'

import { rerank } from './job-publish'
import { STREAM_LOOKAHEAD_SLOTS } from './windows'

import type { ResolvedLanguage } from '@pierre/diffs/worker'
import type { SlotView, TaskEntry, TokenJob, WindowTask } from './job-types'
import type { WorkerRequest } from './protocol'
import type { WindowSpec, WindowViewport } from './windows'

// Windows that have landed. The warm cap counts color actually on screen, not windows dispatched, and
// job-publish.ts counts `final` the same way.
const settledWindows = (job: TokenJob): number =>
	job.windows.filter(task => task.status === 'done').length

// Slots between a window and the reviewer's viewport: 0 when they overlap (the window is what
// the reviewer is looking at), otherwise the gap to the nearer edge.
function viewportGap(window: WindowSpec, viewport: WindowViewport): number {
	const windowFrom = window.startingLine
	const windowTo = windowFrom + window.totalLines
	const viewFrom = viewport.startingLine
	const viewTo = viewFrom + viewport.totalLines
	if (windowTo <= viewFrom) return viewFrom - windowTo
	if (windowFrom >= viewTo) return windowFrom - viewTo
	return 0
}

// One worker is never handed to a prefetch, whatever else is idle: the next click then finds a free
// slot and starts its first window immediately instead of queueing behind band work nobody asked for.
// (A prefetch window already in flight still delays the click by its own duration - one window, and
// only windows dispatched under this budget are ever in flight when the reviewer clicks.)
const WARM_SLOT_RESERVE = 1

// The transport half of the job book: which queued window goes to which worker slot, the task ids
// responses settle against, and the once-per-worker grammar/baggage posts that precede a window.
//
// Scheduling decisions (plan, language arrival, slot releases) stay in job-board.ts, which calls
// drain() and hands over the two registries by reference - same seam as PublishBook.
export class WindowDispatch {
	private nextTaskId = 0

	// The reviewer's own view window per job key (job-board owns the map and assigns this after
	// construction, keeping the constructor at the rule's parameter cap): the stream's gate. Until
	// it is set, dispatch falls back to the plan's own order.
	viewportOf: (cacheKey: string) => WindowViewport | undefined = () =>
		undefined

	constructor(
		private idleSlot: () => SlotView | undefined,
		private jobs: Map<string, TokenJob>,
		private tasks: Map<string, TaskEntry>,
		// One viewport band is split across the pool (windows.ts planWindowOrder), so a band's worth of
		// windows is exactly the pool's width.
		private warmWindowCap: number,
	) {}

	// LPT once languages are known. Each call re-reads the job and dispatches only queued windows, so
	// repeated drains (a boot finishing, a window landing, a language arriving) cannot double-dispatch.
	//
	// Only jobs with a renderer on screen get slots: a job nobody is attached to is a file the reviewer
	// has left, and dispatching its leftovers burns the whole pool on rows that are not visible - an
	// 8000-line file abandoned mid-plan costs ~26 s of tokenize (measured), while the file the reviewer
	// just opened queues behind it. Skipping is not a cancel: landed slices stay merged and a return to
	// the file re-attaches it, which resumes the plan on the next drain. A renderer that detaches and
	// re-attaches around @pierre's converge pass therefore only delays its own next window by one pass.
	// The reviewer's file first, always: a warm job is a prefetch (job-board.openJob's last argument)
	// for a file nobody is looking at yet, and it moves ONLY while no attached job has a window left to
	// send - anything else lets a prefetch delay the rows the reviewer is waiting for (measured: a cold
	// click painted 3.5 s late behind bands accumulated by earlier navigations).
	drain(): void {
		// Keys only: dispatchStalled re-reads the map, and a key never changes under a job.
		const attached: string[] = []
		let newestWarm: string | undefined
		for (const [cacheKey, job] of this.jobs) {
			if (job.instances.size > 0) attached.push(cacheKey)
			// Insertion order, last wins: the newest prefetch is the file the reviewer is walking towards,
			// so the ones opened for files he has already moved past stay frozen (their landed slices keep
			// their cache value, and re-opening one attaches it, which streams it normally).
			else if (job.isWarm && settledWindows(job) < this.warmWindowCap)
				newestWarm = cacheKey
		}
		for (const cacheKey of attached) this.dispatchStalled(cacheKey)
		if (!newestWarm) return
		// An attached job only holds the warm budget back while it still has work inside the stream
		// gate: queued windows beyond it are rows the reviewer has not scrolled to, and blocking the
		// prefetch on them would idle the pool exactly when the reviewer is reading in place.
		if (attached.some(cacheKey => this.nextQueued(this.jobs.get(cacheKey))))
			return
		const budget =
			this.warmWindowCap - WARM_SLOT_RESERVE - this.inFlightWarm()
		if (budget > 0) this.dispatchStalled(newestWarm, budget)
	}

	// Task ids settle against their job key (job-publish.ts deletes the entry when a window lands or
	// fails), so the tasks map is the live in-flight set. A prefetch job that has since been attached is
	// no longer warm work: those windows are the reviewer's own now.
	private inFlightWarm(): number {
		let inFlight = 0
		for (const task of this.tasks.values()) {
			const job = this.jobs.get(task.jobKey)
			if (job?.isWarm && job.instances.size === 0) inFlight++
		}
		return inFlight
	}

	private dispatchStalled(
		cacheKey: string,
		budget = Number.POSITIVE_INFINITY,
	): void {
		for (let sent = 0; sent < budget; sent++) {
			const job = this.jobs.get(cacheKey)
			if (!job?.languages) return
			const queued = this.nextQueued(job)
			if (!queued) return
			const slot = this.idleSlot()
			if (!slot) return
			this.dispatchWindow(slot, cacheKey, queued.spec)
		}
	}

	// The queued window closest to what the reviewer is looking at, provided it sits inside the
	// stream lookahead (windows.ts STREAM_LOOKAHEAD_SLOTS). Without a recorded viewport the plan's
	// own order stands. Beyond the gate a window stays queued - the plan is complete either way,
	// and noteViewport's re-drain on band changes brings it in when the reviewer approaches.
	private nextQueued(job: TokenJob | undefined): WindowTask | undefined {
		if (!job) return undefined
		const viewport = this.viewportOf(job.cacheKey)
		const [nearest] = job.windows
			.filter(task => task.status === 'queued')
			.map(task => ({
				task,
				gap: viewport ? viewportGap(task.spec, viewport) : 0,
			}))
			.toSorted((a, b) => a.gap - b.gap)
		if (!nearest || nearest.gap > STREAM_LOOKAHEAD_SLOTS) return undefined
		return nearest.task
	}

	private dispatchWindow(
		slot: SlotView,
		cacheKey: string,
		spec: WindowSpec,
	): void {
		const job = this.jobs.get(cacheKey)
		if (!job) return
		// Sent BEFORE the post: a fast reply must find the window settled, not queued.
		this.jobs.set(cacheKey, rerank(job, spec, 'sent'))
		this.attachLanguages(slot, job.languages ?? [])
		// open-diff rides ahead in message order; token tasks settle against their id.
		if (!slot.openCacheKeys.has(cacheKey)) {
			slot.openCacheKeys.add(cacheKey)
			// Structured clone of the whole metadata, once per worker per file (item measured before it is
			// shrunk): it runs synchronously on the main thread, so it competes with the first paint.
			const endClone = perfSpan('pool:open-diff')
			slot.send({ type: 'open-diff', cacheKey, diff: job.diff })
			endClone({
				lines: job.diff.splitLineCount,
				hunks: job.diff.hunks.length,
			})
		}
		const id = `job_${++this.nextTaskId}`
		this.tasks.set(id, {
			jobKey: cacheKey,
			spec,
			sentAt: performance.now(),
		})
		perfMark('pool:window:sent', { key: cacheKey, line: spec.startingLine })
		slot.worker.postMessage({
			type: 'token-window',
			id,
			cacheKey,
			window: spec,
		} satisfies WorkerRequest)
	}

	// One grammar transfer per worker per language, in message order, so a window dispatched right
	// after it already sees the grammar; later dispatches cost one Set lookup.
	private attachLanguages(
		slot: SlotView,
		languages: ResolvedLanguage[],
	): void {
		const missing = languages.filter(
			language => !slot.attachedLanguages.has(language.name),
		)
		if (!missing.length) return
		for (const language of missing)
			slot.attachedLanguages.add(language.name)
		perfMark('pool:languages:sent', { count: missing.length })
		slot.send({ type: 'attach-languages', languages: missing })
	}
}
