// The v2 token pool: ONE class owning boot, worker slots, parse tasks, window planning +
// dispatch, the merge grid, publishes, and the @pierre duck-typed surface. It replaces the
// six-module book (manager/job-board/job-publish/job-fleet/window-dispatch/languages/grid-caches)
// with this file; the invariants it keeps are the ones that survived production:
//
// - @pierre repaints only from a highlighted publish, and its converge pass refetches PLAIN rows
//   whenever its renderCache says not-highlighted. So every publish carries highlighted=true
//   (sticky by construction), and `getPlainDiffAST` serves the LIVE merged grid - never a stale
//   plain skeleton - so a converge pass can never throw token rows away.
// - The merged grid always covers every row (plain where tokens have not landed): @pierre indexes
//   rows by per-side content index, so one full-coverage grid serves every range and expansion.
// - Every publish lands as a highlighted flip (publishNow clears the renderer's renderCache
//   first): the pinned renderer repaints mounted rows only on a range change or that one-time
//   flip - never on a later publish - so without the forced flip a stationary reviewer would
//   stare at plain rows forever while the grid behind them colors. The mount itself is plain
//   rows (the base/skeleton); the first publish repaints them colored.
// - A window that never answers must not hold the countdown (and the final) forever: tasks stuck
//   in `sent` past WINDOW_TIMEOUT_MS are reaped as failures on every landing - passive, no timers.
// - Render options are options-scoped: a drift invalidates jobs and caches, workers adopt in
//   order, renderers re-request (their onThemeChange clears @pierre's render cache).
import { areDiffRenderOptionsEqual } from '@pierre/diffs'
import {
	createSkeleton,
	MergeGrid,
} from '@shared/diff-renderer/token-pool/merge'
import {
	DEFAULT_TOKEN_OPTIONS,
	ensurePlainHighlighter,
	isPlainDiff,
	plainHighlighter,
	renderPlainResult,
	resolveLanguagesFor,
	resolvedThemesFor,
} from '@shared/diff-renderer/token-pool/plain'
import {
	STREAM_LOOKAHEAD_SLOTS,
	planWindowOrder,
} from '@shared/diff-renderer/token-pool/windows'
import { listenToWorker } from '@shared/diff-renderer/token-pool/worker-router'
import { perfMark, perfSpan } from '@shared/lib/perf'

import type {
	DiffsHighlighter,
	FileDiffMetadata,
	ThemeRegistrationResolved,
	ThemedDiffResult,
} from '@pierre/diffs'
import type {
	ResolvedLanguage,
	WorkerRenderingOptions,
} from '@pierre/diffs/worker'
import type { ParseInput } from '@shared/diff-renderer/parse-input'
import type {
	WorkerBaggage,
	WorkerPlainGridRequest,
	WorkerRequest,
	WorkerResponse,
	WorkerTokenWindowSuccess,
} from '@shared/diff-renderer/token-pool/protocol'
import type {
	WindowSpec,
	WindowViewport,
} from '@shared/diff-renderer/token-pool/windows'

// The piece of @pierre's renderer the pool publishes into. Duck-typed exactly like pinned: the
// nominal WorkerPoolManager cast happens once in worker-pool.ts, not per call site.
export type PublishRenderer = {
	onHighlightSuccess: (
		diff: FileDiffMetadata,
		result: ThemedDiffResult,
		options: WorkerRenderingOptions,
		highlighted?: boolean,
	) => void
	// The pinned renderer's repaint trigger (a private constructor param = the island's
	// rerender): public at runtime, reachable only through this duck.
	onRenderUpdate?: () => unknown
}

// Below this many characters of old+new side the parse AND the plain base are a few milliseconds
// on the main thread (5 ms at 400 lines, 32 ms at 1 500), so neither pays a worker round trip.
// One threshold for both decisions keeps the two paths from disagreeing.
const INLINE_MAX_CHARS = 48_000

// A window that never answers (crashed worker, lost message) fails instead of blocking the
// countdown; its rows stay plain until a revisit re-tokenizes them.
const WINDOW_TIMEOUT_MS = 30_000

// Slot width trades throughput against memory: every worker holds its own compiled grammars plus
// token caches. One core is left to the main thread (merge, publish, @pierre's layout) and one to
// the OS; the cap is the memory budget, not the core count.
const POOL_MEMORY_CAP = 6
const MIN_POOL_SIZE = 2
const POOL_RESERVED_CORES = 1
const ASSUMED_CORES = 4
export const WORKER_POOL_SIZE = Math.min(
	POOL_MEMORY_CAP,
	Math.max(
		MIN_POOL_SIZE,
		(navigator.hardwareConcurrency || ASSUMED_CORES) - POOL_RESERVED_CORES,
	),
)

// The visible band is split across the whole pool so the first colored paint is one chunk's
// tokenization, not the band's (windows.ts). The plan covers the whole file: every row colors
// eventually, gated to the reviewer's viewport by the drain.
export const BAND_CHUNKS = WORKER_POOL_SIZE

type WindowTask = {
	spec: WindowSpec
	status: 'queued' | 'sent' | 'done'
}
type InFlight = {
	jobKey: string
	spec: WindowSpec
	sentAt: number
	slot: number
}
type QueuedParse = {
	id: string
	input: ParseInput
	accept: (diff: FileDiffMetadata | undefined) => void
}
type PendingBase = { id: string; job: PoolJob }
type ViewportPreparation = {
	tasks: Set<WindowTask>
	totalLines: number
	result: boolean | null
	accepts: Set<(isReady: boolean) => void>
}

type PoolJob = {
	cacheKey: string
	diff: FileDiffMetadata
	options: WorkerRenderingOptions
	// The full-coverage grid: the plain base with every landed window folded in. Undefined until
	// the base lands (worker for big files, synchronous main render for small ones).
	merged: MergeGrid | undefined
	windows: WindowTask[]
	remaining: number
	instances: Set<PublishRenderer>
	preparedRefreshes: Set<() => void>
	languages: ResolvedLanguage[] | undefined
	publishFrame: number | undefined
	// A job nobody is attached to (the next-file prefetch): it moves only on slots the visible
	// file's job leaves free, capped to one viewport band.
	isWarm: boolean
	// The stream gate: the freshest statement of what the reviewer is looking at.
	viewport: WindowViewport | undefined
	// Before the first mount, one viewport band split across the worker fleet may
	// gate the first paint so @pierre adopts colored rows instead of flipping later.
	preparation: ViewportPreparation | undefined
}

type Slot = {
	worker: Worker
	openCacheKeys: Set<string>
	attachedLanguages: Set<string>
	busy: boolean
	// A crashed worker never receives another dispatch; grantSlot skips it. When EVERY slot is
	// dead the boot is failed for good - the desk degrades to the main-thread plain render.
	dead: boolean
}

type ControlEntry = {
	accept: (response: WorkerResponse) => void
	// Parse tasks and init round trips occupy the slot; baggage acks (open-diff, attach-languages)
	// ride a busy slot and must never free it - the window's own reply frees it.
	releasesSlot: boolean
	slot: number
}

// Boot and option-adoption round trips. Messages process in order per worker, so an adoption
// posted after a queued window can never be overtaken by it.
type ControlRequest =
	| {
			type: 'initialize'
			renderOptions: WorkerRenderingOptions
			resolvedThemes: ThemeRegistrationResolved[]
			resolvedLanguages: ResolvedLanguage[]
	  }
	| {
			type: 'set-render-options'
			renderOptions: WorkerRenderingOptions
			resolvedThemes: ThemeRegistrationResolved[]
	  }

export class TokenPool {
	private poolSize: number
	private renderOptions: WorkerRenderingOptions
	private slots: Slot[] = []
	// taskId -> awaited control round trip (parses, init/adoption, baggage acks, the plain base).
	private waiting = new Map<string, ControlEntry>()
	// taskId -> in-flight window task (responses and the reaper settle against it).
	private tasks = new Map<string, InFlight>()
	// Parses are dispatch-first: they take the next free slot ahead of window work, and they need
	// no shiki - they stream while the initialize round trips run.
	private parseQueue: QueuedParse[] = []
	// Plain-base tasks waiting for a free slot. A base gates a mount, so it outranks every
	// window; re-dispatching from the drain (instead of a stray timer) keeps the retry ordered.
	private pendingBases: PendingBase[] = []
	private nextTaskId = 0

	private jobs = new Map<string, PoolJob>()
	// Settled grids per cacheKey (revisit hits and @pierre's cache adoption), FIFO-capped: entries
	// are full node grids and giant listings reach megabytes.
	private finals = new Map<
		string,
		{ result: ThemedDiffResult; options: WorkerRenderingOptions }
	>()
	private static readonly FINAL_CAP = 24
	// Plain renders stashed for reuse: the renderer's sync plain request before a job exists, and
	// the inline base a small file's own job adopts. FIFO-capped like the finals.
	private skeletons = new Map<string, ThemedDiffResult>()
	private static readonly SKELETON_CAP = 3

	// The main-thread highlighter answers the sync plain paths (small-file bases, plain diffs,
	// the degraded boot-failure path). Started alongside the fleet at boot - never gating it -
	// and re-created here if that first attempt failed.
	private fallbackHighlighter:
		| Promise<DiffsHighlighter | undefined>
		| undefined

	private bootPromise: Promise<void> | undefined
	private bootDone = false
	private bootFailed = false
	private themeSubscribers = new Set<{ onThemeChange?: () => void }>()

	// Options adoptions are serialized AND coalesced: two edits in flight must reach the workers
	// in order, or the slower earlier one lands last and the pool keeps tokenizing against stale
	// options. A burst collapses into the loop's next pass.
	private adopting = false
	private adoptionPending = false

	private rangeMarks = 0
	private static readonly VIEWPORT_MARK_CAP = 12

	// Grammar resolves in flight and their results, per cacheKey. Languages are content-scoped
	// and options-independent, so they survive adoptions.
	private languageJobs = new Map<string, Promise<void>>()
	private languageValues = new Map<string, ResolvedLanguage[]>()

	constructor(
		private workerFactory: () => Worker,
		poolSize: number,
		initialOptions?: WorkerRenderingOptions,
	) {
		this.poolSize = poolSize
		this.renderOptions = { ...DEFAULT_TOKEN_OPTIONS, ...initialOptions }
		perfMark('pool:create', { slots: poolSize })
	}

	// ══════════════ boot ══════════════

	// Idempotent: the renderer cannot ask for tokens until this settles, and a second boot would
	// spawn a second fleet and orphan the first one's slots.
	warmBoot(): Promise<void> {
		this.bootPromise ??= this.runBoot()
		return this.bootPromise
	}

	// @pierre starts every supplied manager through this public lifecycle method. Syneva also warms
	// the same boot on idle, so both entry points must share the one idempotent promise.
	initialize(): Promise<void> {
		return this.warmBoot()
	}

	private async runBoot(): Promise<void> {
		perfMark('pool:boot:start')
		try {
			// Workers only need the resolved theme data; resolving themes is the boot's first
			// stage and everything else (spawn + per-worker initialize) runs in parallel.
			const themes = await resolvedThemesFor(this.renderOptions)
			perfMark('pool:themes')
			// The main-thread highlighter serves the sync plain paths; it must not gate the
			// fleet, so it starts alongside and is never awaited here.
			this.ensureFallbackHighlighter()
			this.slots = Array.from({ length: this.poolSize }, () => ({
				worker: this.workerFactory(),
				openCacheKeys: new Set<string>(),
				attachedLanguages: new Set<string>(),
				busy: false,
				dead: false,
			}))
			for (const [index, slot] of this.slots.entries())
				listenToWorker(slot.worker, {
					onControl: (_worker, id, response) =>
						this.forwardControl(index, id, response),
					onWindowSuccess: (_worker, response) =>
						this.onWindowSuccess(index, response),
					onWindowFailure: (_worker, id, failure) =>
						this.onTaskFailure(index, id, failure),
					onWorkerError: () => this.onWorkerCrash(index),
				})
			// Parses only need a live worker, so they dispatch ahead of the initialize acks;
			// windows wait for the whole fleet (the bootDone gate in the drain).
			await Promise.all(
				this.slots.map(async (slot, index) => {
					const started = performance.now()
					await this.postControl(index, {
						type: 'initialize',
						renderOptions: this.renderOptions,
						resolvedThemes: themes,
						resolvedLanguages: [],
					})
					perfMark('pool:worker:ready', {
						slot: index,
						ms: Math.round(performance.now() - started),
					})
				}),
			)
			// Every worker crashing while its initialize was in flight fails the boot for good.
			if (this.bootFailed) return
			perfMark('pool:boot:done', { slots: this.slots.length })
			this.bootDone = true
			this.drain()
		} catch (error) {
			this.failBoot(
				error instanceof Error ? error.message : String(error),
			)
		}
	}

	// ══════════════ @pierre surface ══════════════

	isWorkingPool(): boolean {
		return true
	}

	isInitialized(): boolean {
		return this.bootDone
	}

	getDiffRenderOptions(): WorkerRenderingOptions {
		return { ...this.renderOptions }
	}

	getFileRenderOptions(): {
		theme: WorkerRenderingOptions['theme']
		useTokenTransformer: boolean
		tokenizeMaxLineLength: number
	} {
		const { theme, useTokenTransformer, tokenizeMaxLineLength } =
			this.renderOptions
		return { theme, useTokenTransformer, tokenizeMaxLineLength }
	}

	// @pierre's cache-adoption path: a settled grid - or an opening-viewport-prepared live grid -
	// is adopted as highlighted on the renderer's own render pass, with no publish round trip.
	getDiffResultCache(
		diff: FileDiffMetadata,
	):
		| { result: ThemedDiffResult; options: WorkerRenderingOptions }
		| undefined {
		if (!diff.cacheKey) return undefined
		const final = this.finals.get(diff.cacheKey)
		if (final) return final
		const job = this.jobs.get(diff.cacheKey)
		if (job?.preparation?.result && job.merged)
			return { result: job.merged.result(), options: job.options }
		return undefined
	}

	// A renderer adopting a prepared cache never calls highlightDiffAST. Its cache
	// shares the MergeGrid's mutable rows, so streaming only needs a repaint callback
	// after each merge; no private @pierre renderer surface is involved.
	attachPreparedRefresh(diff: FileDiffMetadata, refresh: () => void): void {
		if (!diff.cacheKey) return
		const job = this.jobs.get(diff.cacheKey)
		if (!job?.preparation?.result) return
		job.preparedRefreshes.add(refresh)
		job.isWarm = false
		this.drain()
	}

	// syneva never constructs file-renderer instances (diff renderers only), so the file half of
	// the pinned surface stays inert rather than half-implemented.
	getFileResultCache(): undefined {
		return undefined
	}

	primeFileHighlightCache(): void {
		// See getFileResultCache.
	}

	// The renderer's request for plain rows while tokens are in flight. Order of truth: settled
	// final > live merged grid > stashed plain render > fresh plain render (stashed for the job
	// that will adopt it as its base). The requested range is also the freshest statement of what
	// the reviewer is looking at: noteViewport keeps it as the job's stream gate.
	getPlainDiffAST(
		diff: FileDiffMetadata,
		startingLine: number,
		totalLines: number,
	): ThemedDiffResult | undefined {
		this.noteViewport(diff.cacheKey, startingLine, totalLines)
		const final = diff.cacheKey ? this.finals.get(diff.cacheKey) : undefined
		if (final) return final.result
		const job = diff.cacheKey ? this.jobs.get(diff.cacheKey) : undefined
		if (job?.merged) return job.merged.result()
		if (!diff.cacheKey) return renderPlainResult(diff, this.renderOptions)
		const stashed = this.skeletons.get(diff.cacheKey)
		if (stashed) return stashed
		if (!plainHighlighter()) {
			// The highlighter boots alongside the fleet; a render pass that raced it gets plain
			// rows on a later pass (the boot's own re-request path).
			void this.warmBoot()
			return undefined
		}
		const plain = renderPlainResult(diff, this.renderOptions)
		if (plain) {
			this.skeletons.set(diff.cacheKey, plain)
			this.trim(this.skeletons, TokenPool.SKELETON_CAP)
		}
		return plain
	}

	highlightDiffAST(instance: PublishRenderer, diff: FileDiffMetadata): void {
		if (
			!this.bootDone ||
			this.bootFailed ||
			isPlainDiff(diff) ||
			!diff.cacheKey
		)
			return
		const job = this.jobs.get(diff.cacheKey)
		if (job) {
			// Attach and re-drain: the instance's own render painted plain rows; the publishes
			// that follow each window landing repaint them colored.
			job.instances.add(instance)
			this.drain()
			return
		}
		this.openJob(diff, instance, false)
	}

	// Background priming without a renderer (the next-file prefetch): same pipeline, publishes
	// naturally suppressed, the settled result lands in the cache for the click.
	primeDiffHighlightCache(diff: FileDiffMetadata): void {
		if (
			this.bootFailed ||
			isPlainDiff(diff) ||
			!diff.cacheKey ||
			this.jobs.has(diff.cacheKey)
		)
			return
		this.openJob(diff, undefined, true)
	}

	cleanUpTasks(instance: PublishRenderer): void {
		// Detach only: sent windows keep running so the result lands in the cache (a revisit
		// reuses it instead of re-tokenizing).
		for (const job of this.jobs.values()) job.instances.delete(instance)
	}

	subscribeToThemeChanges(instance: {
		onThemeChange?: () => void
	}): () => void {
		this.themeSubscribers.add(instance)
		return () => {
			this.themeSubscribers.delete(instance)
		}
	}

	unsubscribeToThemeChanges(instance: { onThemeChange?: () => void }): void {
		this.themeSubscribers.delete(instance)
	}

	// Stats feed dashboards syneva doesn't run; a stable no-op subscription (pinned's shape).
	subscribeToStatChanges(): () => void {
		return () => {}
	}

	getStats(): Record<string, number | boolean | string> {
		return {
			managerState: this.bootDone ? 'initialized' : 'initializing',
			totalSlots: this.slots.length,
			activeJobs: this.jobs.size,
			cacheEntries: this.finals.size,
		}
	}

	terminate(): void {
		for (const slot of this.slots) slot.worker.terminate()
		this.slots = []
		this.waiting.clear()
		this.tasks.clear()
		for (const parse of this.parseQueue.splice(0)) parse.accept(undefined)
		this.pendingBases = []
		// A copy: settleJobFailed mutates the same map the loop reads.
		const jobs = [...this.jobs.values()]
		for (const job of jobs) this.settleJobFailed(job)
		this.jobs.clear()
		this.finals.clear()
		this.skeletons.clear()
		this.languageJobs.clear()
		this.languageValues.clear()
		this.bootDone = false
		this.bootPromise = undefined
	}

	async setRenderOptions(options: {
		theme?: WorkerRenderingOptions['theme']
		lineDiffType?: WorkerRenderingOptions['lineDiffType']
	}): Promise<void> {
		const next: WorkerRenderingOptions = {
			...this.renderOptions,
			theme: options.theme ?? this.renderOptions.theme,
			lineDiffType:
				options.lineDiffType ?? this.renderOptions.lineDiffType,
		}
		if (areDiffRenderOptionsEqual(next, this.renderOptions)) return
		this.renderOptions = next
		this.adoptionPending = true
		if (this.adopting) return
		this.adopting = true
		try {
			await this.drainAdoptions()
		} finally {
			this.adopting = false
		}
	}

	// Recursion, not a loop: each pass re-reads whatever options landed last.
	private async drainAdoptions(): Promise<void> {
		if (!this.adoptionPending) return
		this.adoptionPending = false
		try {
			// Token state is options-scoped and dies with the version: the jobs are dropped and the
			// mounts re-render from the NEW options' plain fetch.
			const activeJobs = Array.from(this.jobs.values())
			for (const job of activeJobs) this.settleJobFailed(job)
			this.finals.clear()
			this.skeletons.clear()
			for (const instance of this.themeSubscribers)
				instance.onThemeChange?.()
			this.ensureFallbackHighlighter()
			const themes = await resolvedThemesFor(this.renderOptions)
			await Promise.all(
				this.slots.map((_, index) =>
					this.postControl(index, {
						type: 'set-render-options',
						renderOptions: this.renderOptions,
						resolvedThemes: themes,
					}),
				),
			)
			this.drain()
		} catch (error) {
			console.error('token pool failed to adopt render options:', error)
		}
		await this.drainAdoptions()
	}

	// ══════════════ public pipeline ══════════════

	// Grammar resolve for a diff, started the moment a render pass knows the language (it is a
	// chunk fetch + registration, longer than the worker boot - the two overlap). Render passes
	// call this every pass; the languageJobs guard makes it once per key.
	prewarmLanguages(diff: FileDiffMetadata): void {
		const { cacheKey } = diff
		if (!cacheKey || this.languageJobs.has(cacheKey)) return
		this.languageJobs.set(cacheKey, this.resolveLanguages(cacheKey, diff))
	}

	private async resolveLanguages(
		cacheKey: string,
		diff: FileDiffMetadata,
	): Promise<void> {
		try {
			const languages = await resolveLanguagesFor(diff)
			this.languageJobs.delete(cacheKey)
			// An empty resolve (both sides map to 'text') is never cached: the job stays gated on
			// languages and the file keeps its plain rows - the right answer for content no
			// grammar covers - and a later pass retries the resolve for free.
			if (!languages.length) return
			this.languageValues.set(cacheKey, languages)
			const job = this.jobs.get(cacheKey)
			if (job && !job.languages) {
				job.languages = languages
				this.drain()
			}
		} catch (error) {
			console.error('token pool could not resolve grammars:', error)
			this.languageJobs.delete(cacheKey)
		}
	}

	// The click path's parse, as a pool task (priority over window work, needs no shiki so it
	// streams while initialize round trips run). Undefined = declined (small file - the inline
	// parse is cheaper) or failed (the caller falls back to the main-thread parse).
	parseDiff(input: ParseInput): Promise<FileDiffMetadata | undefined> {
		const endOffload = perfSpan('pool:parse:offloaded')
		if (
			input.oldContents.length + input.newContents.length <
				INLINE_MAX_CHARS ||
			this.bootFailed
		) {
			endOffload({ offloaded: false })
			return Promise.resolve(undefined)
		}
		void this.warmBoot()
		return new Promise(resolve => {
			this.parseQueue.push({
				id: `parse_${++this.nextTaskId}`,
				input,
				accept: diff => {
					endOffload({ offloaded: !!diff })
					resolve(diff)
				},
			})
			this.drain()
		})
	}

	// The warm pipeline for a diff nobody is looking at yet (the next-file prefetch): opens the
	// job once the boot has settled, so its windows ride the idle slots. The cold path has no
	// caller here - @pierre's own highlight request opens the job at mount time
	// (highlightDiffAST), attached from its first window.
	async primeJob(
		diff: FileDiffMetadata,
		viewport: WindowViewport | undefined,
	): Promise<void> {
		if (!diff.cacheKey || isPlainDiff(diff)) return
		await this.warmBoot()
		if (this.bootFailed || this.jobs.has(diff.cacheKey)) return
		this.openJob(diff, undefined, true, { viewport })
	}

	// Gate only the first mount on the reviewer's estimated opening viewport. The
	// merged grid remains full coverage (plain outside this window), so @pierre can
	// adopt it once and the unchanged stream keeps coloring future windows.
	async prepareViewport(
		diff: FileDiffMetadata,
		viewport: WindowViewport,
	): Promise<boolean> {
		const { cacheKey } = diff
		if (!cacheKey || isPlainDiff(diff)) return false
		await this.warmBoot()
		if (this.bootFailed) return false
		if (this.finals.has(cacheKey)) return true
		const existing = this.jobs.get(cacheKey)
		const job =
			existing ?? this.openJob(diff, undefined, false, { viewport })
		if (!job) return false
		job.isWarm = false
		job.viewport = viewport
		if (!job.preparation) this.installPreparation(job, viewport)
		this.drain()
		return this.waitForPreparation(job.preparation)
	}

	private installPreparation(job: PoolJob, viewport: WindowViewport): void {
		const count = Math.min(BAND_CHUNKS, viewport.totalLines)
		const specs = planWindowOrder(job.diff, viewport, BAND_CHUNKS).slice(
			0,
			count,
		)
		if (!specs.length) return
		const tasks: WindowTask[] = specs.map(spec => ({
			spec,
			status: 'queued',
		}))
		job.windows.unshift(...tasks)
		job.remaining += tasks.length
		job.preparation = {
			tasks: new Set(tasks),
			totalLines: viewport.totalLines,
			result: null,
			accepts: new Set(),
		}
	}

	private waitForPreparation(
		preparation: ViewportPreparation | undefined,
	): Promise<boolean> {
		if (!preparation) return Promise.resolve(false)
		if (preparation.result !== null)
			return Promise.resolve(preparation.result)
		return new Promise(resolve => preparation.accepts.add(resolve))
	}

	private openingPreparation(
		windows: WindowTask[],
		viewport: WindowViewport | undefined,
		bandChunks: number,
	): ViewportPreparation | undefined {
		if (!viewport) return undefined
		const count = Math.min(bandChunks, viewport.totalLines)
		return {
			tasks: new Set(windows.slice(0, count)),
			totalLines: viewport.totalLines,
			result: null,
			accepts: new Set(),
		}
	}

	// Open (or fail) synchronously; the base is queued for the drain. Undefined means there is
	// nothing to tokenize - no job is created and the mount's plain fetch serves the file.
	private openJob(
		diff: FileDiffMetadata,
		instance: PublishRenderer | undefined,
		isWarm: boolean,
		opening?: { viewport?: WindowViewport; bandChunks?: number },
	): PoolJob | undefined {
		const { cacheKey } = diff
		if (!cacheKey) return undefined
		const { viewport, bandChunks = BAND_CHUNKS } = opening ?? {}
		const plan = planWindowOrder(diff, viewport, bandChunks)
		if (!plan.length) return undefined
		const windows: WindowTask[] = plan.map(spec => ({
			spec,
			status: 'queued',
		}))
		const merged = this.inlineBase(diff, cacheKey)
		perfMark('pool:job:open', {
			key: cacheKey,
			windows: plan.length,
			lines: diff.splitLineCount,
			prefetch: isWarm ? 1 : 0,
		})
		const job: PoolJob = {
			cacheKey,
			diff,
			options: { ...this.renderOptions },
			merged,
			windows,
			remaining: plan.length,
			instances: instance ? new Set([instance]) : new Set(),
			preparedRefreshes: new Set(),
			languages: this.languageValues.get(cacheKey),
			publishFrame: undefined,
			isWarm,
			viewport,
			preparation: this.openingPreparation(windows, viewport, bandChunks),
		}
		this.jobs.set(cacheKey, job)
		this.prewarmLanguages(diff)
		if (!merged)
			this.pendingBases.push({ id: `base_${++this.nextTaskId}`, job })
		this.drain()
		return job
	}

	// The renderer's synchronous plain request already produced the full grid before asking for
	// highlights. Adopt that grid regardless of file size: sending the same diff to a worker to
	// rebuild it holds every token window behind an unnecessary round trip. Only create a new
	// base inline for small files; large prefetch jobs without a stash still use the worker.
	private inlineBase(
		diff: FileDiffMetadata,
		cacheKey: string,
	): MergeGrid | undefined {
		const stashed = this.skeletons.get(cacheKey)
		if (!stashed) {
			const chars =
				diff.deletionLines.reduce(
					(total, line) => total + line.length,
					0,
				) +
				diff.additionLines.reduce(
					(total, line) => total + line.length,
					0,
				)
			if (chars > INLINE_MAX_CHARS) return undefined
		}
		const plain = stashed ?? renderPlainResult(diff, this.renderOptions)
		if (!plain) return undefined
		this.skeletons.delete(cacheKey)
		return new MergeGrid(createSkeleton(plain))
	}

	private settleJobFailed(job: PoolJob): void {
		this.completePreparation(job, false)
		this.jobs.delete(job.cacheKey)
	}

	// The whole-file countdown reached zero: publish the last rows synchronously (the rAF would
	// outlive the job), then cache the fully merged grid as the settled result.
	private settleJobFinal(job: PoolJob): void {
		const grid = job.merged
		this.publishNow(job)
		this.jobs.delete(job.cacheKey)
		if (grid) {
			this.finals.set(job.cacheKey, {
				result: grid.result(),
				options: job.options,
			})
			this.trim(this.finals, TokenPool.FINAL_CAP)
		}
		perfMark('pool:final', { key: job.cacheKey })
	}

	// One merged window settled (success, failure, reaper, or worker crash): the shared tail that
	// keeps the countdown and the publish cadence honest.
	private finishTask(
		job: PoolJob,
		task: WindowTask,
		isSuccessful = false,
	): void {
		task.status = 'done'
		job.remaining--
		this.settlePreparationTask(job, task, isSuccessful && !!job.merged)
		if (job.remaining === 0) {
			this.settleJobFinal(job)
			return
		}
		this.schedulePublish(job)
		this.drain()
	}

	private settlePreparationTask(
		job: PoolJob,
		task: WindowTask,
		isReady: boolean,
	): void {
		const { preparation } = job
		if (!preparation?.tasks.delete(task)) return
		if (!isReady) {
			this.completePreparation(job, false)
			return
		}
		if (preparation.tasks.size === 0) this.completePreparation(job, true)
	}

	private completePreparation(job: PoolJob, isReady: boolean): void {
		const { preparation } = job
		if (preparation?.result !== null) return
		preparation.result = isReady
		for (const accept of preparation.accepts) accept(isReady)
		preparation.accepts.clear()
		perfMark('pool:viewport:ready', {
			key: job.cacheKey,
			lines: preparation.totalLines,
			ready: isReady,
		})
	}

	// ══════════════ dispatch ══════════════

	// A granted slot: the pool routes replies by slot index (crash handling), dispatches
	// baggage to the slot's worker, and never hands the same busy slot out twice.
	private grantSlot(): { slot: Slot; index: number } | undefined {
		const index = this.slots.findIndex(slot => !slot.busy && !slot.dead)
		if (index === -1) return undefined
		const slot = this.slots[index]
		slot.busy = true
		return { slot, index }
	}

	private drain(): void {
		this.drainParses()
		if (!this.bootDone) return
		this.drainBases()
		this.drainWindows()
	}

	// Parses first: the click path's latency is parse + band, never window work. Parses need a
	// live worker, not a settled boot - they stream while the initialize round trips run.
	private drainParses(): void {
		while (this.parseQueue.length) {
			const granted = this.grantSlot()
			if (!granted) return
			const parse = this.parseQueue.shift()
			if (!parse) return
			this.postParse(granted.index, parse)
		}
	}

	// Bases next: each one gates a mount (the cold-open hold).
	private drainBases(): void {
		while (this.pendingBases.length) {
			const granted = this.grantSlot()
			if (!granted) return
			const base = this.pendingBases.shift()
			if (!base) return
			// The job may have died while queued (adoption, failure): skip, don't send.
			if (this.jobs.get(base.job.cacheKey) !== base.job) continue
			this.sendBase(base, granted.index)
		}
	}

	// Attached jobs first, nearest the viewport, inside the stream lookahead: beyond it a window
	// stays queued until a scroll brings it in range (the plan is complete either way -
	// noteViewport re-drains on band changes). The newest warm job gets one window per drain on
	// slots the attached work leaves free, and never the last free slot: the click that follows
	// must find a slot for its parse or its base without waiting a full window.
	private drainWindows(): void {
		const attached: string[] = []
		let newestWarm: string | undefined
		for (const [cacheKey, job] of this.jobs) {
			if (
				job.instances.size > 0 ||
				job.preparedRefreshes.size > 0 ||
				job.preparation?.result === null
			)
				attached.push(cacheKey)
			else if (
				job.isWarm &&
				job.windows.filter(window => window.status === 'done').length <
					BAND_CHUNKS
			)
				newestWarm = cacheKey
		}
		for (const cacheKey of attached) this.dispatchStalled(cacheKey)
		if (!newestWarm) return
		// A warm job holds nothing back while an attached job still has in-gate work queued.
		if (
			attached.some(cacheKey => {
				const job = this.jobs.get(cacheKey)
				return !!job && !!this.nextQueued(job)
			})
		)
			return
		const freeSlots = this.slots.filter(
			slot => !slot.busy && !slot.dead,
		).length
		if (freeSlots <= 1) return
		this.dispatchStalled(newestWarm, 1)
	}

	private dispatchStalled(cacheKey: string, budget = Infinity): void {
		for (let sent = 0; sent < budget; sent++) {
			const job = this.jobs.get(cacheKey)
			if (!job?.languages?.length || !job.merged) return
			const task = this.nextQueued(job)
			if (!task) return
			const granted = this.grantSlot()
			if (!granted) return
			this.dispatchWindow(granted.slot, granted.index, job, task)
		}
	}

	// The queued window closest to the viewport, inside the lookahead gate. Without a recorded
	// viewport the plan's own order stands.
	private nextQueued(job: PoolJob): WindowTask | undefined {
		const { viewport } = job
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
		slot: Slot,
		slotIndex: number,
		job: PoolJob,
		task: WindowTask,
	): void {
		// Settled BEFORE the post: a fast reply must find the window sent, not queued.
		task.status = 'sent'
		const id = `job_${++this.nextTaskId}`
		this.tasks.set(id, {
			jobKey: job.cacheKey,
			spec: task.spec,
			sentAt: performance.now(),
			slot: slotIndex,
		})
		this.attachLanguages(slotIndex, job.languages ?? [])
		if (!slot.openCacheKeys.has(job.cacheKey)) {
			slot.openCacheKeys.add(job.cacheKey)
			const endClone = perfSpan('pool:open-diff')
			this.postBaggage(slotIndex, {
				type: 'open-diff',
				cacheKey: job.cacheKey,
				diff: job.diff,
			})
			endClone({
				lines: job.diff.splitLineCount,
				hunks: job.diff.hunks.length,
			})
		}
		perfMark('pool:window:sent', {
			key: job.cacheKey,
			line: task.spec.startingLine,
		})
		slot.worker.postMessage({
			type: 'token-window',
			id,
			cacheKey: job.cacheKey,
			window: task.spec,
		} satisfies WorkerRequest)
	}

	// One grammar transfer per worker per language, in message order, so a window dispatched
	// right after it already sees the grammar; later dispatches cost one Set lookup.
	private attachLanguages(
		slotIndex: number,
		languages: ResolvedLanguage[],
	): void {
		const slot = this.slots[slotIndex]
		const missing = languages.filter(
			language => !slot.attachedLanguages.has(language.name),
		)
		if (!missing.length) return
		for (const language of missing)
			slot.attachedLanguages.add(language.name)
		perfMark('pool:languages:sent', { count: missing.length })
		this.postBaggage(slotIndex, {
			type: 'attach-languages',
			languages: missing,
		})
	}

	// ══════════════ transport ══════════════

	private releaseSlot(slotIndex: number): void {
		this.slots[slotIndex].busy = false
	}

	// Baggage rides a busy slot: its ack is consumed by a non-releasing entry, never by the
	// slot-freeing fallback (which would hand a tokenizing worker's slot to another task).
	private postBaggage(slotIndex: number, request: WorkerBaggage): void {
		const slot = this.slots[slotIndex]
		const id = `bag_${++this.nextTaskId}`
		this.waiting.set(id, {
			accept: () => {},
			releasesSlot: false,
			slot: slotIndex,
		})
		slot.worker.postMessage({ ...request, id } satisfies WorkerRequest)
	}

	// Init and adoption round trips: resolve when the worker answers, log its failures, never
	// free the slot (nothing else is dispatched to it while the round trip runs).
	private postControl(
		slotIndex: number,
		request: ControlRequest,
	): Promise<void> {
		return new Promise(resolve => {
			const id = `ctl_${++this.nextTaskId}`
			this.waiting.set(id, {
				accept: response => {
					if (response.type === 'error')
						console.error(
							'token worker control task failed:',
							response.error,
						)
					resolve()
				},
				releasesSlot: false,
				slot: slotIndex,
			})
			this.slots[slotIndex]?.worker.postMessage({
				...request,
				id,
			} satisfies WorkerRequest)
		})
	}

	private postParse(slotIndex: number, parse: QueuedParse): void {
		const slot = this.slots[slotIndex]
		// Registered before the post: a fast reply must find its waiter.
		this.waiting.set(parse.id, {
			accept: response => {
				parse.accept(
					response.type === 'success' &&
						response.requestType === 'parse-diff'
						? response.diff
						: undefined,
				)
			},
			releasesSlot: true,
			slot: slotIndex,
		})
		slot.worker.postMessage({
			type: 'parse-diff',
			id: parse.id,
			input: parse.input,
		} satisfies WorkerRequest)
	}

	private sendBase(base: PendingBase, slotIndex: number): void {
		const { id, job } = base
		const slot = this.slots[slotIndex]
		this.waiting.set(id, {
			accept: response => this.onBaseResponse(job, response),
			releasesSlot: true,
			slot: slotIndex,
		})
		if (!slot.openCacheKeys.has(job.cacheKey)) {
			slot.openCacheKeys.add(job.cacheKey)
			const endClone = perfSpan('pool:open-diff')
			this.postBaggage(slotIndex, {
				type: 'open-diff',
				cacheKey: job.cacheKey,
				diff: job.diff,
			})
			endClone({
				lines: job.diff.splitLineCount,
				hunks: job.diff.hunks.length,
			})
		}
		perfMark('pool:base:sent', { key: job.cacheKey })
		slot.worker.postMessage({
			type: 'plain-grid',
			id,
			cacheKey: job.cacheKey,
		} satisfies WorkerPlainGridRequest)
	}

	// ══════════════ responses ══════════════

	private forwardControl(
		slotIndex: number,
		id: string,
		response: WorkerResponse,
	): void {
		const entry = this.waiting.get(id)
		if (entry) {
			this.waiting.delete(id)
			if (entry.releasesSlot) this.releaseSlot(slotIndex)
			entry.accept(response)
			return
		}
		// An unregistered ack still frees its slot - but never a slot that is running a window:
		// those replies route as window tasks, and baggage acks carry their own entries.
		this.releaseSlot(slotIndex)
	}

	private onBaseResponse(job: PoolJob, response: WorkerResponse): void {
		// The job may have died while the base was in flight (adoption, failure).
		if (this.jobs.get(job.cacheKey) !== job) return
		if (
			response.type === 'error' ||
			response.requestType !== 'plain-grid'
		) {
			console.error(
				'token pool plain base failed:',
				response.type === 'error'
					? response.error
					: response.requestType,
			)
			this.settleJobFailed(job)
			return
		}
		perfMark('pool:base', { key: job.cacheKey, ms: response.ms })
		job.merged = new MergeGrid(
			createSkeleton({
				code: response.code,
				themeStyles: response.themeStyles,
				baseThemeType: response.baseThemeType,
			}),
		)
		this.skeletons.delete(job.cacheKey)
		// Windows can move now that the grid exists; a publish follows for any instance that
		// attached early (the mount's own highlight request).
		this.drain()
		this.schedulePublish(job)
	}

	private onWindowSuccess(
		slotIndex: number,
		response: WorkerTokenWindowSuccess,
	): void {
		this.releaseSlot(slotIndex)
		this.sweepStale()
		const inflight = this.tasks.get(response.id)
		this.tasks.delete(response.id)
		if (!inflight) return
		// The response's window is a structured CLONE; the inflight entry holds the main-thread
		// spec the plan dispatched - match everything against that reference.
		const job = this.jobs.get(inflight.jobKey)
		const task = job?.windows.find(window => window.spec === inflight.spec)
		if (!job || !task) return
		const endSpan = perfSpan('pool:merge')
		job.merged?.mergeWindow(inflight.spec, {
			code: response.code,
			positions: response.positions,
		})
		endSpan({ kind: inflight.spec.kind, key: job.cacheKey })
		perfMark('pool:window:done', {
			key: job.cacheKey,
			ms: Math.round(performance.now() - inflight.sentAt),
			kind: inflight.spec.kind,
			line: inflight.spec.startingLine,
			...response.timings,
		})
		this.finishTask(job, task, true)
	}

	private onTaskFailure(
		slotIndex: number,
		id: string,
		failure: WorkerResponse,
	): void {
		// Control round trips (parse, init, adoption, the plain base) fail through here too:
		// resolve the waiter and free its slot if it held one. Window tasks settle as plain rows.
		const entry = this.waiting.get(id)
		if (entry) {
			this.waiting.delete(id)
			if (entry.releasesSlot) this.releaseSlot(slotIndex)
			entry.accept(failure)
			return
		}
		this.releaseSlot(slotIndex)
		this.sweepStale()
		const inflight = this.tasks.get(id)
		this.tasks.delete(id)
		if (!inflight) return
		if (failure.type === 'error')
			console.error('token window task failed:', failure.error)
		const job = this.jobs.get(inflight.jobKey)
		const task = job?.windows.find(window => window.spec === inflight.spec)
		if (!job || !task) return
		this.finishTask(job, task)
	}

	// A dead worker leaves its in-flight tasks unresolved; failing them now (instead of waiting
	// for the reaper) keeps the file's countdown honest and the slots free.
	private onWorkerCrash(slotIndex: number): void {
		const slot = this.slots[slotIndex]
		slot.dead = true
		slot.busy = false
		console.error('diff-token worker crashed')
		// Copies: the loops below mutate the maps they read.
		const entries = [...this.waiting]
		for (const [id, entry] of entries) {
			if (entry.slot !== slotIndex) continue
			this.waiting.delete(id)
			entry.accept({ type: 'error', id, error: 'worker crashed' })
		}
		const inflight = [...this.tasks]
		for (const [id, sent] of inflight) {
			if (sent.slot !== slotIndex) continue
			this.tasks.delete(id)
			const job = this.jobs.get(sent.jobKey)
			const task = job?.windows.find(window => window.spec === sent.spec)
			if (job && task) this.finishTask(job, task)
		}
		if (this.slots.length > 0 && this.slots.every(dead => dead.dead))
			this.failBoot('every worker crashed')
		this.drain()
	}

	// Sticky: retries would fight across render passes. Every gate opens false (the plain fetch
	// serves the mount), every parse declines, and the main-thread highlighter takes over.
	private failBoot(reason: string): void {
		if (this.bootFailed) return
		this.bootFailed = true
		console.error(
			`token pool unavailable (${reason}); degrading to the main-thread plain render`,
		)
		this.ensureFallbackHighlighter()
		this.failAllParses()
		for (const base of this.pendingBases.splice(0))
			this.settleJobFailed(base.job)
		const jobs = [...this.jobs.values()]
		for (const job of jobs) this.settleJobFailed(job)
		this.drain()
	}

	private failAllParses(): void {
		for (const parse of this.parseQueue.splice(0)) parse.accept(undefined)
	}

	// A window stuck in `sent` past the timeout resolves as a failure on the next landing -
	// passive sweep, no timers, nothing to clean up.
	private sweepStale(): void {
		const now = performance.now()
		const stale: string[] = []
		for (const [id, inflight] of this.tasks)
			if (now - inflight.sentAt > WINDOW_TIMEOUT_MS) stale.push(id)
		if (!stale.length) return
		for (const id of stale) {
			const inflight = this.tasks.get(id)
			if (!inflight) continue
			this.tasks.delete(id)
			const job = this.jobs.get(inflight.jobKey)
			const task = job?.windows.find(
				window => window.spec === inflight.spec,
			)
			if (job && task) this.finishTask(job, task)
		}
		this.drain()
	}

	// ══════════════ publishes ══════════════

	// One merged grid per rAF, always highlighted=true: publishNow clears each instance's
	// renderCache first, so the publish lands as the highlighted flip and the pinned renderer's
	// own flip-repaint paints the merged grid's token rows into the DOM.
	private schedulePublish(job: PoolJob): void {
		if (job.publishFrame || !job.merged) return
		const frame = requestAnimationFrame(() => {
			job.publishFrame = undefined
			if (this.jobs.get(job.cacheKey) !== job || !job.merged) return
			this.publishNow(job)
		})
		job.publishFrame = frame
	}

	private publishNow(job: PoolJob): void {
		if (!job.merged) return
		const endSpan = perfSpan('pool:publish')
		for (const instance of job.instances) {
			// The pinned renderer repaints mounted rows only through its flip: onHighlightSuccess
			// fires its private onRenderUpdate (= the island's rerender) ONLY when the cache was
			// not already highlighted - so after the first publish, later publishes refresh
			// cache.result while the DOM keeps the stale paint. Fire the repaint trigger on every
			// publish; the cache stays (clearing it would make onHighlightSuccess early-return and
			// swallow the update). Note onHighlightSuccess also resets renderRange to undefined,
			// so the refreshed cache is valid for whatever window is on screen.
			instance.onHighlightSuccess(
				job.diff,
				job.merged.result(),
				job.options,
				true,
			)
			instance.onRenderUpdate?.()
		}
		for (const refresh of job.preparedRefreshes) refresh()
		endSpan({
			key: job.cacheKey,
			landed: job.windows.filter(window => window.status === 'done')
				.length,
			total: job.windows.length,
			lines: job.diff.splitLineCount,
		})
	}

	// ══════════════ helpers ══════════════

	// The main-thread highlighter is only created when a sync plain path needs it (it starts
	// alongside the boot fleet). A failed attempt is retried on the next need, never cached.
	private async bootFallbackHighlighter(): Promise<
		DiffsHighlighter | undefined
	> {
		try {
			return await ensurePlainHighlighter(this.renderOptions)
		} catch (error) {
			console.error(
				'token pool could not boot the main-thread plain highlighter:',
				error,
			)
			this.fallbackHighlighter = undefined
			return undefined
		}
	}

	private ensureFallbackHighlighter(): void {
		this.fallbackHighlighter ??= this.bootFallbackHighlighter()
	}

	// The stream gate: the freshest statement of what the reviewer is looking at.
	noteViewport(
		cacheKey: string | undefined,
		startingLine: number,
		totalLines: number,
	): void {
		if (!cacheKey) return
		const job = this.jobs.get(cacheKey)
		const previous = job?.viewport
		if (job) job.viewport = { startingLine, totalLines }
		// A reviewer scrolling into unscheduled slots must move the stream with them.
		const band = Math.floor(startingLine / STREAM_LOOKAHEAD_SLOTS)
		if (
			previous &&
			Math.floor(previous.startingLine / STREAM_LOOKAHEAD_SLOTS) !== band
		)
			this.drain()
		if (this.rangeMarks < TokenPool.VIEWPORT_MARK_CAP) {
			this.rangeMarks++
			perfMark('pool:range', { from: startingLine, lines: totalLines })
		}
	}

	private trim<V>(cache: Map<string, V>, cap: number): void {
		while (cache.size > cap) {
			const oldest = cache.keys().next().value
			if (!oldest) break
			cache.delete(oldest)
		}
	}
}

// Slots between a window and the reviewer's viewport: 0 when they overlap, otherwise the gap to
// the nearer edge.
function viewportGap(window: WindowSpec, viewport: WindowViewport): number {
	const windowFrom = window.startingLine
	const windowTo = windowFrom + window.totalLines
	const viewFrom = viewport.startingLine
	const viewTo = viewFrom + viewport.totalLines
	if (windowTo <= viewFrom) return viewFrom - windowTo
	if (windowFrom >= viewTo) return windowFrom - viewTo
	return 0
}
