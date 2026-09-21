import type { ReviewState } from '../domain/review.js'

// The desk's state ownership lives in exactly two variables: the current immutable root
// and the revision that advances only when that root is replaced. Copy-on-write: mutations
// never edit a root in place, they build a new root (unchanged branches shared by
// reference) and publish it with commit - a root that differs from the current one becomes
// the live state and advances the revision; the same root is a no-op.
export type StateOwner = {
	readonly state: ReviewState
	readonly revision: number
	commit: (next: ReviewState) => void
}

export function createStateOwner(initial: ReviewState): StateOwner {
	// The startup root is frozen ONCE here, at the ownership boundary: after publication
	// neither the caller's original object nor any shared branch of it may be edited, or a
	// mutation could become visible without a commit (stale revision, stale /api/state cache
	// body). Committed roots are NOT re-frozen per mutation - they are built fresh by the
	// copy-on-write use cases, and re-walking every root on each commit would cost a full
	// deep traversal per mutation. Types (transitively readonly ReviewState) carry the rest.
	deepFreeze(initial)
	let current = initial
	let revision = 0
	return {
		get state(): ReviewState {
			return current
		},
		get revision(): number {
			return revision
		},
		commit(next: ReviewState): void {
			if (next === current) return
			current = next
			revision += 1
		},
	}
}

// Deep-freeze plain review data (records, arrays, string-keyed hashes). Non-plain leaves
// (primitives) are already immutable; anything unexpected is frozen only at the object level.
function deepFreeze(node: unknown): void {
	if (node && typeof node === 'object') {
		for (const child of Object.values(node)) deepFreeze(child)
		Object.freeze(node)
	}
}
