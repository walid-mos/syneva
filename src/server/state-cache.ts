// The desk's serialized /api/state body, cached across requests.
//
// Building it is not cheap: browserState() walks every change block, decision, comment and guide of
// a diff that can span a whole PR, and JSON.stringify then copies all of it - on a desk whose tab
// re-reads the projection whenever the diff moves and whose CLI probes it per command.
//
// The body is a function of exactly two inputs, and neither can stand in for the other. The live
// review moves without baseDiffHash moving (decisions, comments, guide, staged records are all
// reviewer/agent writes on an unchanged diff), so no diff-derived key works. The transient half of
// the response - DeskStatus plus serverInstanceId - describes the desk PROCESS, not the review
// (agent activity, parked awaiters, queued events, a restarted server), so no review revision alone
// works either. Hence the two-part key: invalidate() for the review, the caller's transientKey for
// the process.
export type StateBodyCache = {
	// The live review changed: the next body() must re-render.
	invalidate(): void
	mutate<T>(mutation: () => Promise<T>): Promise<T>
	// The serialized response body for the current review revision plus `transientKey` - the caller's
	// serialized transient half, re-derived cheaply per request. `render` runs only on a miss, and is
	// called here rather than handed in pre-built so a request can never pair a body it rendered with
	// a key that no longer holds.
	body(transientKey: string, render: () => string): string
}

export function createStateBodyCache(): StateBodyCache {
	let revision = 0
	let activeMutations = 0
	let cached: {
		revision: number
		transientKey: string
		body: string
	} | null = null
	return {
		invalidate(): void {
			revision += 1
		},
		async mutate<T>(mutation: () => Promise<T>): Promise<T> {
			activeMutations++
			revision++
			try {
				return await mutation()
			} finally {
				activeMutations--
				revision++
			}
		},
		body(transientKey: string, render: () => string): string {
			// Read routes stay outside the mutex. A writer can yield between in-place
			// edits, so neither the old body nor an intermediate snapshot may be reused.
			if (activeMutations) return render()
			if (
				cached?.revision === revision &&
				cached.transientKey === transientKey
			)
				return cached.body
			const body = render()
			cached = { revision, transientKey, body }
			return body
		},
	}
}
