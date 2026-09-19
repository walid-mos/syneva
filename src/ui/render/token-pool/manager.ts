// Application-owned token pool adapter, duck-typed where @pierre's renderers pass a worker
// manager (`new FileDiff(options, <this>)` / `new VirtualDiff(..., <this>)`). The nominal
// WorkerPoolManager cast happens ONCE in render/worker-pool.ts, not per call site.
//
// Two identities, exactly like pinned: highlightDiffAST / cleanUpTasks / onHighlightSuccess act
// on the DiffHunksRenderer (one per instance, disposed via recycle()); subscribeToThemeChanges
// acts on the FileDiff itself (onThemeChange -> clearRenderCache + rerender).
//
// Deviation from pinned: highlightDiffAST plans token windows (windows.ts) instead of one
// full-file task, merges them into a full plain skeleton (merge.ts; ~37 ms to build at 16k
// lines - pinned pays a per-pass plain render instead), and publishes per rAF through
// onHighlightSuccess(..., false), which makes @pierre's renderer re-request highlights on its
// next pass - dedupe against the open job is what terminates scheduling; the final publish
// carries highlighted=true and lands the merged result in the result cache.
import { areDiffRenderOptionsEqual } from '@pierre/diffs'

import { perfMark } from '../../perf'

import { JobBoard } from './job-board'
import { DEFAULT_POOL_SIZE, TokenFleet } from './job-fleet'
import {
	DEFAULT_TOKEN_OPTIONS,
	ensurePlainHighlighter,
	isPlainDiff,
	plainHighlighter,
	resolvedThemesFor,
} from './plain'

import type { FileDiffMetadata, ThemedDiffResult } from '@pierre/diffs'
import type { WorkerRenderingOptions } from '@pierre/diffs/worker'
import type { PublishRenderer } from './job-types'

export type TokenPoolBootstrapOptions = {
	poolOptions: { workerFactory: () => Worker; poolSize?: number }
	highlighterOptions: {
		theme?: WorkerRenderingOptions['theme']
		lineDiffType?: WorkerRenderingOptions['lineDiffType']
		// Accepted for @pierre call-shape parity; syneva resolves languages lazily per task.
		langs?: string[]
	}
}

export class TokenPoolManager {
	private renderOptions: WorkerRenderingOptions
	private bootPromise: Promise<void> | undefined
	private adopting = false
	private adoptionPending = false
	private bootDone = false
	private bootFailed = false
	private fleet: TokenFleet
	private board: JobBoard
	private themeSubscribers = new Set<{ onThemeChange?: () => void }>()

	constructor({
		poolOptions,
		highlighterOptions,
	}: TokenPoolBootstrapOptions) {
		this.renderOptions = {
			...DEFAULT_TOKEN_OPTIONS,
			theme: highlighterOptions.theme ?? DEFAULT_TOKEN_OPTIONS.theme,
			lineDiffType:
				highlighterOptions.lineDiffType ??
				DEFAULT_TOKEN_OPTIONS.lineDiffType,
		}
		this.fleet = new TokenFleet(
			poolOptions.workerFactory,
			poolOptions.poolSize ?? DEFAULT_POOL_SIZE,
		)
		this.board = new JobBoard(
			this.fleet.grantIdleSlot.bind(this.fleet),
			poolOptions.poolSize ?? DEFAULT_POOL_SIZE,
		)
		perfMark('pool:create')
		// Fire-and-forget, like pinned's constructor: renderers re-request at their next repaint.
		this.queueInitialization()
	}

	// ============ surface ============

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

	getDiffResultCache(diff: FileDiffMetadata):
		| {
				result: ThemedDiffResult
				options: WorkerRenderingOptions
		  }
		| undefined {
		if (!diff.cacheKey) return undefined
		return this.board.cachedFinal(diff.cacheKey)
	}

	// syneva never constructs file-renderer instances (diff renderers only), so the file half of
	// the pinned surface stays inert rather than half-implemented.
	getFileResultCache(): undefined {
		return undefined
	}

	primeFileHighlightCache(): void {
		// See getFileResultCache.
	}

	// The renderer's request for plain rows while tokens are in flight. Always a full grid:
	// @pierre looks rows up by per-side content index, so a superset serves every range and
	// expansion state the renderer slices at (see class header). The range the renderer asks for
	// is also the freshest statement of what the reviewer is looking at: the board keeps it as
	// the job's viewport to prioritize (render/token-pool/job-board.ts).
	getPlainDiffAST(
		diff: FileDiffMetadata,
		startingLine: number,
		totalLines: number,
	): ThemedDiffResult | undefined {
		if (!plainHighlighter() || isPlainDiff(diff)) {
			this.queueInitialization()
			return undefined
		}
		this.board.noteViewport(diff.cacheKey, startingLine, totalLines)
		return this.board.servePlainRows(diff, this.renderOptions)
	}

	// The render pass names the diff's grammar before it asks for tokens (or for plain rows), which
	// is the earliest certain statement of what the first colored rows will need. See
	// job-board.prewarmLanguages for why the resolve is started here rather than on job open.
	prewarmLanguages(diff: FileDiffMetadata): void {
		this.board.prewarmLanguages(diff)
	}

	highlightDiffAST(instance: PublishRenderer, diff: FileDiffMetadata): void {
		if (this.bootFailed || !this.isInitialized() || isPlainDiff(diff))
			return
		this.requestTokens(instance, diff)
	}

	// Background priming without an existing renderer: same pipeline, publishes naturally
	// suppressed (no instances), the final result lands in the cache for the next switch.
	primeDiffHighlightCache(diff: FileDiffMetadata): void {
		if (this.bootFailed || !this.isInitialized() || isPlainDiff(diff))
			return
		this.requestTokens(undefined, diff)
	}

	cleanUpTasks(instance: PublishRenderer): void {
		// Detach only; already-sent windows keep running so the result lands in the cache (a
		// revisit reuses it instead of re-tokenizing).
		this.board.detachInstance(instance)
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
			managerState: this.isInitialized() ? 'initialized' : 'initializing',
			...this.fleet.statsFleetShape(),
			...this.board.statsShape(),
		}
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
		// Adoptions are serialized AND coalesced: two edits in flight (a theme change right after a
		// line-diff change) must reach the workers in order, or the slower earlier one lands last and
		// the pool keeps tokenizing against stale options. A burst collapses into the loop's next
		// pass, which reads whatever `this.renderOptions` holds by then.
		this.adoptionPending = true
		if (this.adopting) return
		this.adopting = true
		try {
			await this.drainAdoptions()
		} finally {
			this.adopting = false
		}
	}

	// Recursion, not a loop: each pass re-reads whatever options landed last, so a burst collapses
	// into one extra pass instead of one adoption per change.
	private async drainAdoptions(): Promise<void> {
		if (!this.adoptionPending) return
		this.adoptionPending = false
		await this.adoptOptions()
		await this.drainAdoptions()
	}

	// Never rejects: the only caller fires and forgets (syncPoolRenderOptions), and a rejected
	// promise there would surface as an unhandled rejection with no one to act on it.
	private async adoptOptions(): Promise<void> {
		try {
			await this.initialize()
			await ensurePlainHighlighter(this.renderOptions)
			// Token state is options-scoped; renderers re-request under the new version (their
			// onThemeChange clears the render cache).
			this.board.invalidate()
			for (const instance of this.themeSubscribers)
				instance.onThemeChange?.()
			const themes = await resolvedThemesFor(this.renderOptions)
			await this.fleet.adoptOptions(this.renderOptions, themes)
			this.board.drain()
		} catch (error) {
			console.error('token pool failed to adopt render options:', error)
		}
	}

	terminate(): void {
		this.fleet.terminateWorkers()
		this.board.invalidate()
		this.bootDone = false
		this.bootPromise = undefined
	}

	// ============ boot ============

	private queueInitialization(): void {
		if (!this.bootPromise) void this.startBoot()
	}

	// Idempotent by construction: a second boot would spawn a second worker fleet and orphan the
	// first one's slots, re-run the highlighter setup and flood the main thread - the render path
	// (queueInitialization) and the direct initialize() callers both funnel here, and so does the
	// idle warm-up below. The renderer cannot ask for tokens until this settles (getPlainDiffAST is
	// synchronous and @pierre only requests highlights after initialize() resolves), so the plain
	// highlighter's boot sits on every cold open's critical path unless something warms it first.
	private startBoot(): Promise<void> {
		if (this.bootPromise) return this.bootPromise
		const boot = this.runBoot()
		this.bootPromise = boot
		return boot
	}

	// Idle-time warm-up of the whole boot chain (highlighter, themes, workers): measured 62-110 ms of
	// main-thread engine work for the highlighter alone, of which the chunk fetch is 5 ms.
	warmBoot(): void {
		void this.startBoot()
	}

	// A failed boot is sticky: retries would fight across render passes; the desk still paints
	// plain rows (@pierre renders renderCache without tokens) and a reload reruns the pool.
	private async runBoot(): Promise<void> {
		perfMark('pool:boot:start')
		try {
			// The highlighter (main thread, engine + themes) and the resolved themes are independent, and
			// the workers only need the themes: resolving them in parallel takes the smaller of the two
			// off the boot instead of adding them up (measured ~15-25 ms).
			const [, themes] = await Promise.all([
				ensurePlainHighlighter(this.renderOptions),
				resolvedThemesFor(this.renderOptions),
			])
			perfMark('pool:plain-highlighter')
			await this.fleet.spawnWorkers({
				board: this.board,
				initialOptions: this.renderOptions,
				themes,
			})
			perfMark('pool:boot:done', { slots: this.fleet.spawnedSlots() })
			this.board.drain()
			this.bootDone = true
		} catch (error) {
			this.bootFailed = true
			console.error('token pool failed to initialize:', error)
		}
	}

	private async initialize(): Promise<void> {
		if (this.bootDone) return
		await this.startBoot()
	}

	// ============ request path ============

	private requestTokens(
		instance: PublishRenderer | undefined,
		diff: FileDiffMetadata,
	): void {
		if (!diff.cacheKey) return
		if (this.board.jobOpen(diff.cacheKey)) {
			this.board.attachInstance(instance, diff.cacheKey)
			this.board.drain()
			return
		}
		this.board.openJob(diff, instance, this.renderOptions)
	}

	// Warm a file the reviewer has not opened (the next one in review order, render/prefetch.ts): the job
	// is planned and handed only the slots an attached job does not need, so the click that opens it
	// publishes colored rows from cache instead of a tokenize pass the reviewer watches as grey rows.
	prefetchDiff(diff: FileDiffMetadata): void {
		if (!diff.cacheKey || this.board.jobOpen(diff.cacheKey)) return
		this.board.openJob(diff, undefined, this.renderOptions, true)
	}

	detachRenderer(instance: PublishRenderer): void {
		this.board.detachInstance(instance)
	}

	// Stash (grid-caches) lives on the board: stale results stay there.
}
