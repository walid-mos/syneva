// Grid caches for the token pool: the final merged results (revisit hits) and in-flight plain
// skeletons (the renderer's sync plain requests stream through them). Entries are full node
// grids (giant listings reach megabytes); both stay small FIFOs scoped per content cacheKey.
import type { ThemedDiffResult } from '@pierre/diffs'
import type { WorkerRenderingOptions } from '@pierre/diffs/worker'

const RESULT_CACHE_CAP = 24
const PENDING_SKELETON_CAP = 3

export type GridFinal = {
	result: ThemedDiffResult
	options: WorkerRenderingOptions
}

export class GridCaches {
	private skeletons = new Map<string, ThemedDiffResult>()
	private results = new Map<
		string,
		{ result: ThemedDiffResult; options: WorkerRenderingOptions }
	>()

	// The renderer's renderCache swap path reads {result, options} and checks option equality.
	cachedFinal(
		cacheKey: string,
	):
		| { result: ThemedDiffResult; options: WorkerRenderingOptions }
		| undefined {
		return this.results.get(cacheKey)
	}

	stashedSkeleton(cacheKey: string): ThemedDiffResult | undefined {
		return this.skeletons.get(cacheKey)
	}

	stashSkeleton(cacheKey: string, skeleton: ThemedDiffResult): void {
		this.skeletons.set(cacheKey, skeleton)
		this.trimFifo(this.skeletons, PENDING_SKELETON_CAP)
	}

	invalidate(): void {
		this.skeletons.clear()
		this.results.clear()
	}

	cacheFinal(
		cacheKey: string,
		run: { result: ThemedDiffResult; options: WorkerRenderingOptions },
	): void {
		this.results.set(cacheKey, run)
		this.trimFifo(this.results, RESULT_CACHE_CAP)
	}

	statsShape(): { cacheEntries: number } {
		return { cacheEntries: this.results.size }
	}

	private trimFifo(cache: Map<string, unknown>, cap: number): void {
		while (cache.size > cap) {
			const oldest = cache.keys().next().value
			// Non-empty here guarantees the iterator yields a key.
			if (!oldest) break
			cache.delete(oldest)
		}
	}
}
