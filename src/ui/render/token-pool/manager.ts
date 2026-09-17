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

import { JobBoard } from './job-board'
import { TokenFleet } from './job-fleet'
import {
	DEFAULT_TOKEN_OPTIONS,
	ensurePlainHighlighter,
	isPlainDiff,
	plainHighlighter,
	resolvedThemesFor,
} from './plain'

import type { FileDiffMetadata, ThemedDiffResult } from '@pierre/diffs'
import type { WorkerRenderingOptions } from '@pierre/diffs/worker'
import type { PublishRenderer } from './job-board'

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
			poolOptions.poolSize,
		)
		this.board = new JobBoard(this.fleet.grantIdleSlot.bind(this.fleet))
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
	// expansion state the renderer slices at (see class header).
	getPlainDiffAST(diff: FileDiffMetadata): ThemedDiffResult | undefined {
		if (!plainHighlighter() || isPlainDiff(diff)) {
			this.queueInitialization()
			return undefined
		}
		return this.board.servePlainRows(diff, this.renderOptions)
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
		await this.initialize()
		await ensurePlainHighlighter(this.renderOptions)
		// Token state is options-scoped; renderers re-request under the new version (their
		// onThemeChange clears the render cache).
		this.board.invalidate()
		for (const instance of this.themeSubscribers) instance.onThemeChange?.()
		const themes = await resolvedThemesFor(this.renderOptions)
		await this.fleet.adoptOptions(this.renderOptions, themes)
		this.board.drain()
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

	private startBoot(): Promise<void> {
		const boot = this.runBoot()
		this.bootPromise = boot
		return boot
	}

	// A failed boot is sticky: retries would fight across render passes; the desk still paints
	// plain rows (@pierre renders renderCache without tokens) and a reload reruns the pool.
	private async runBoot(): Promise<void> {
		try {
			await ensurePlainHighlighter(this.renderOptions)
			const themes = await resolvedThemesFor(this.renderOptions)
			await this.fleet.spawnWorkers({
				board: this.board,
				initialOptions: this.renderOptions,
				themes,
			})
			this.board.drain()
			this.bootDone = true
		} catch (error) {
			this.bootFailed = true
			console.error('token pool failed to initialize:', error)
		}
	}

	private async initialize(): Promise<void> {
		if (!this.bootDone) await this.startBoot()
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

	detachRenderer(instance: PublishRenderer): void {
		this.board.detachInstance(instance)
	}

	// Stash (grid-caches) lives on the board: stale results stay there.
}
