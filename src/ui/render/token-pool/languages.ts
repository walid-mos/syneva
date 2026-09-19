import { resolveLanguagesFor } from './plain'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { ResolvedLanguage } from '@pierre/diffs/worker'

// Grammars for the diffs being tokenized, resolved once each and started EARLIER than the job that
// needs them: the render pass's own parse knows the file's grammar before the pool is asked for
// anything, and resolving it is a chunk fetch plus shiki registration - longer than the worker boot
// it used to queue behind, so it overlaps that boot instead.
//
// Wider lifetime than a job: the resolve begins before the pool has a booted fleet for the diff,
// and the value outlives an options invalidation (a grammar is language data, not option data).
export class LanguageBook {
	private promises = new Map<string, Promise<ResolvedLanguage[]>>()
	// The answer, once known: openJob reads it synchronously so a job that opens AFTER its grammars
	// resolved dispatches its first window in that same turn. Awaiting the promise instead parks the
	// continuation behind whatever task is running - on a cold open that is the renderer's first paint
	// (~300 ms), during which the workers would sit idle.
	private values = new Map<string, ResolvedLanguage[]>()

	// Idempotent: the render pass calls this on every pass, the resolve runs once per diff.
	prewarm(diff: FileDiffMetadata): void {
		const { cacheKey } = diff
		if (!cacheKey || this.promises.has(cacheKey)) return
		this.promises.set(cacheKey, this.resolve(diff))
	}

	// Undefined while nothing is known yet (the job stays queued), the resolved list - empty on
	// failure - as soon as the answer landed.
	settled(cacheKey: string): ResolvedLanguage[] | undefined {
		return this.values.get(cacheKey)
	}

	// Undefined for a diff that was never prewarmed (no renderer asked for it yet).
	pending(cacheKey: string): Promise<ResolvedLanguage[]> | undefined {
		return this.promises.get(cacheKey)
	}

	// Empty rather than rejected on failure: the job then tokenizes nothing and renders plain, while
	// the rest of the pool keeps working (and no caller has to handle a rejection it cannot act on).
	private async resolve(diff: FileDiffMetadata): Promise<ResolvedLanguage[]> {
		const { cacheKey } = diff
		try {
			const languages = await resolveLanguagesFor(diff)
			if (cacheKey) this.values.set(cacheKey, languages)
			return languages
		} catch (error) {
			console.error('token pool could not resolve grammars:', error)
			if (cacheKey) this.values.set(cacheKey, [])
			return []
		}
	}
}
