// The desk's serialized /api/state body, cached across requests.
//
// Building it is not cheap: browserState() walks every change block, decision, comment and guide of
// a diff that can span a whole PR, and JSON.stringify then copies all of it - on a desk whose tab
// re-reads the projection whenever the diff moves and whose CLI probes it per command.
//
// The body is a function of exactly two inputs, and neither can stand in for the other. The review
// moves only when a mutation commits a different state root, and the desk's application revision
// advances exactly then (see DeskContext.commit) - so the revision covers the review half. The
// transient half - DeskStatus plus serverInstanceId - describes the desk PROCESS, not the review
// (agent activity, parked awaiters, queued events, a restarted server), so no revision alone works
// either. Hence the two-part key.
//
// Reads stay outside the write mutex: with copy-on-write state a reader captures one immutable root
// and renders from it, so it can never observe an in-place intermediate. The caller reads the
// revision BEFORE the root (see serveState): a commit landing between the two reads can then only
// park a body under the OLDER revision, which the next read's revision check rejects - never serve
// a stale body under the newer one.
export type StateBodyCache = {
	// The serialized response body for review `revision` plus `transientKey` - the caller's
	// serialized transient half, re-derived cheaply per request. `render` runs only on a miss,
	// and is called here rather than handed in pre-built so a request can never pair a body it
	// rendered with a key that no longer holds.
	body(revision: number, transientKey: string, render: () => string): string
}

export function createStateBodyCache(): StateBodyCache {
	let cached: {
		revision: number
		transientKey: string
		body: string
	} | null = null
	return {
		body(revision, transientKey, render) {
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
