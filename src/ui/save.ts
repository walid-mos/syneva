import type { ReviewerSave } from './types'

// The reviewer-owned slice posted to /api/save - never the whole (multi-MB) ReviewState.
// The server holds rawDiff/file contents/changes/etc. authoritatively and merges only these
// fields. It's a full picture of the reviewer-owned state (snapshot semantics), so the
// coalesced trailing save re-derives it and latest wins. Enumerating keys explicitly (rather
// than deleting server fields off a clone) guarantees the wire never carries file contents.
export function reviewerSlice(state: ReviewerSave): ReviewerSave {
	return {
		decisions: state.decisions,
		comments: state.comments,
		reviewedFiles: state.reviewedFiles,
		reviewedFileHashes: state.reviewedFileHashes,
		decisionFiles: state.decisionFiles,
	}
}

// Coalescing auto-saver. There's no manual Save button, so every reviewer mutation
// (decision, comment, sign-off) triggers a save; approving files back-to-back used to
// fire one full-state POST each, saturating the 6-connection-per-origin cap while the
// server block-serialized multi-MB JSON. This keeps at most one save in flight and
// collapses everything requested while one is outstanding into a single TRAILING save.
//
// The trailing save re-reads getPayload() at send time (latest-wins over a full snapshot
// of the reviewer-owned slice), so it reflects the newest state, not whatever was current
// when the intermediate triggers fired. send/getPayload are injected so the coalescing
// logic is unit-testable without a browser or fetch.
export type Saver = {
	// Request a save. Sends immediately if idle; otherwise schedules exactly one trailing save.
	trigger: () => void
	// In-flight OR a trailing save pending - a save is "busy" until the wire is quiet again.
	// The poll's reload branch checks this so it never adopts server state over local
	// mutations that haven't been persisted yet (see poll.ts).
	isBusy: () => boolean
}

export function createSaver<T>(
	getPayload: () => T,
	send: (payload: T) => Promise<unknown>,
): Saver {
	let isInFlight = false
	let isPending = false

	const run = (): void => {
		isInFlight = true
		// async/await (not .finally) so a rejected save still drains the trailing one - a failed
		// in-flight save must never strand a queued save. Errors are otherwise swallowed:
		// fire-and-forget, no retry machinery (the next mutation will re-trigger anyway).
		void (async () => {
			try {
				await send(getPayload())
			} catch {
				// Swallowed by design: a failed save is not retried here.
			} finally {
				isInFlight = false
				if (isPending) {
					isPending = false
					run()
				}
			}
		})()
	}

	return {
		trigger() {
			if (isInFlight) isPending = true
			else run()
		},
		isBusy() {
			return isInFlight || isPending
		},
	}
}
