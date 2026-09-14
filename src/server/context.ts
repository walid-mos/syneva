import { randomUUID } from 'node:crypto'

import { createSerializer } from '../mutex.js'
import { persistReview } from '../state/persistence.js'

import type { Serializer } from '../mutex.js'
import type { DeskStatus, ReviewState } from '../types.js'
import type { DeskActivity } from './activity.js'
import type { Binding } from './binding.js'
import type { EventStream } from './events.js'
import type { ServerOptions } from './options.js'
import type { IdleWatchdog } from './shutdown.js'

// Everything a route needs from the running desk: the live review, the launch options, the
// origin guard's authority set, the liveness collaborators, and the two operations every mutating
// route shares (persist, and serialize through the mutation mutex).
export type DeskContext = {
	instanceId: string
	state: ReviewState
	options: ServerOptions
	binding: Binding
	events: EventStream
	activity: DeskActivity
	watchdog: IdleWatchdog
	serialize: Serializer
	status(): DeskStatus
	// Persist the live review, adopting the stamp the written file carries, and hand back its path.
	persist(): Promise<string>
	shutdown(reason: 'idle' | 'stop'): void
}

export function createDeskContext(
	state: ReviewState,
	options: ServerOptions,
	collaborators: {
		binding: Binding
		events: EventStream
		activity: DeskActivity
		watchdog: IdleWatchdog
		shutdown: (reason: 'idle' | 'stop') => void
	},
): DeskContext {
	const { binding, events, activity, watchdog, shutdown } = collaborators
	return {
		instanceId: randomUUID(),
		state,
		options,
		binding,
		events,
		activity,
		watchdog,
		// Serialize every state/git-index-mutating route through one promise-chain mutex. Both
		// /api/send and /api/reload walk `state` across several awaits (send: the reviewer-save
		// patch → the staged snapshot → persistReview → buildReviewResult; reload: buildReviewState →
		// mergeReviewState → Object.assign(state) → the staged snapshot → persistReview). With no
		// mutual exclusion a reload's Object.assign landing mid-send emits a ReviewResult (and persists
		// a file) stitched from two snapshots - a baseDiffHash that no longer agrees with the
		// decisions/changes beside it, or a reviewer save silently overwritten by a reload built from
		// a pre-save snapshot. This is the exact window the two-actor design opens (an agent calls
		// `galley reload` while the reviewer hits Send). Read-only routes (/api/state, /api/poll,
		// /api/file*, /api/tree) stay OUTSIDE the queue, and the /api/await-send long-poll MUST stay
		// out - it parks for the length of a round, so serializing it would wedge every mutation
		// behind a waiter that only a mutation releases.
		serialize: createSerializer(),
		status(): DeskStatus {
			const queued = events.queuedCounts()
			return {
				agentActivity: activity.read(),
				agentListening: events.listenerCount() > 0,
				queuedQuestions: queued.questions,
				queuedReviews: queued.reviews,
			}
		},
		async persist(): Promise<string> {
			const persisted = await persistReview(state)
			Object.assign(state, persisted.stamp)
			return persisted.file
		},
		shutdown,
	}
}
