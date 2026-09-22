import { randomUUID } from 'node:crypto'

import { createSerializer } from '../../../application/mutex.js'
import { readStagedSnapshot } from '../../../application/reconcile.js'
import { createStateBodyCache } from '../../../application/state-cache.js'
import { createStateOwner } from '../../../application/state-owner.js'

import type { DeskStatus } from '../../../../contracts/browser.js'
import type { DeskActivity } from '../../../application/activity.js'
import type { EventStream } from '../../../application/events.js'
import type { Serializer } from '../../../application/mutex.js'
import type {
	EditorPort,
	GitPort,
	ReviewStorePort,
	SettingsPort,
} from '../../../application/ports.js'
import type { StateBodyCache } from '../../../application/state-cache.js'
import type { ReviewState } from '../../../domain/review.js'
import type { Binding } from './binding.js'
import type { ServerOptions } from './options.js'
import type { IdleWatchdog } from './shutdown.js'

// The persist outcome a route needs: the stamped root to commit plus the file it was written to.
export type PersistedState = { state: ReviewState; file: string }

// Everything a route needs from the running desk: the live review, the launch options, the
// origin guard's authority set, the liveness collaborators, and the state-ownership operations
// every route shares (commit, persist, and the write mutex).
export type DeskContext = {
	instanceId: string
	// The current immutable state root. Copy-on-write: mutations never edit a root in place -
	// they build a NEW root (unchanged branches shared by reference) and publish it with
	// `commit`. One reference read is atomic in JS, so a reader captures a consistent snapshot
	// without the write mutex and can never observe an in-place intermediate.
	readonly state: ReviewState
	// The application revision: monotonic, advanced ONLY when a mutation commits a different
	// state root (commit of the same root is a no-op). The /api/state body cache keys on it.
	readonly revision: number
	options: ServerOptions
	binding: Binding
	events: EventStream
	activity: DeskActivity
	watchdog: IdleWatchdog
	// Application-owned capability ports, wired by the composition root (bootstrap/server).
	git: GitPort
	store: ReviewStorePort
	settings: SettingsPort
	editor: EditorPort
	// Serialize every mutating route through one promise-chain mutex. Mutual exclusion ORDERS
	// writes - a concurrent /api/send and /api/reload each compute their next root from the
	// latest committed one, so neither can overwrite the other mid-flight (this is the exact
	// window the two-actor design opens: an agent calls `syneva reload` while the reviewer hits
	// Send). It no longer guards READS: copy-on-write state makes `ctx.state` a consistent
	// snapshot on its own. The /api/await-send long-poll MUST stay out - it parks for the
	// length of a round, so serializing it would wedge every mutation behind a waiter that
	// only a mutation releases.
	serialize: Serializer
	// Publish a mutation's next state root - the ONLY way live state changes. A root that
	// differs from the current one becomes the live state and advances the revision; the same
	// root is a no-op, so an unchanged desk keeps serving its cached /api/state body.
	commit(next: ReviewState): void
	// Persist `next` and hand back the stamped root to commit (the stamp the written file
	// carries - updatedAt/persistFile - is adopted as a state change like any other) plus the
	// file's path (Send writes its result artifact next to it).
	persist(next: ReviewState): Promise<PersistedState>
	// The serialized /api/state body, keyed on the application revision plus the transient
	// desk status (see state-cache.ts).
	stateBodyCache: StateBodyCache
	status(): DeskStatus
	// Reflect the live git index onto the review for the read routes (/api/state, /api/tree).
	// The index snapshot is read OUTSIDE the write mutex (a git spawn is the desk's slowest
	// operation); the conditional commit re-validates under it - a mutation that landed
	// mid-read re-computes against the newest root instead of overwriting it. An unchanged
	// index commits nothing, so the same root keeps serving the cached body.
	refreshStaged(): Promise<void>
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
		git: GitPort
		store: ReviewStorePort
		settings: SettingsPort
		editor: EditorPort
		shutdown: (reason: 'idle' | 'stop') => void
	},
): DeskContext {
	const { events, activity, git, store, shutdown } = collaborators
	const runMutation = createSerializer()
	const stateBodyCache = createStateBodyCache()
	const owner = createStateOwner(state)
	return {
		// The collaborators ARE the context's collaborators - spread, not re-listed.
		...collaborators,
		instanceId: randomUUID(),
		options,
		stateBodyCache,
		get state(): ReviewState {
			return owner.state
		},
		get revision(): number {
			return owner.revision
		},
		commit: owner.commit,
		serialize: runMutation,
		status(): DeskStatus {
			return deskStatus(events, activity)
		},
		refreshStaged(): Promise<void> {
			return refreshStagedIndex(
				() => owner.state,
				git,
				runMutation,
				owner.commit,
			)
		},
		persist(next: ReviewState): Promise<PersistedState> {
			return persistState(store, next)
		},
		shutdown,
	}
}

// Persist next and hand back the stamped root to commit: the stamp the written file carries
// (updatedAt/persistFile) is adopted as a state change like any other.
async function persistState(
	store: ReviewStorePort,
	next: ReviewState,
): Promise<PersistedState> {
	const persisted = await store.persistReview(next)
	return { state: { ...next, ...persisted.stamp }, file: persisted.file }
}

// The desk status is derived read-only from the event stream and the agent activity log.
function deskStatus(events: EventStream, activity: DeskActivity): DeskStatus {
	const queued = events.queuedCounts()
	return {
		agentActivity: activity.read(),
		agentListening: events.listenerCount() > 0,
		queuedQuestions: queued.questions,
		queuedReviews: queued.reviews,
	}
}

// Reflect the live git index onto the review for the read routes (/api/state, /api/tree).
// The index snapshot is read OUTSIDE the write mutex (a git spawn is the desk's slowest
// operation); the conditional commit re-validates under it - a mutation that landed
// mid-read re-computes against the newest root instead of overwriting it. An unchanged
// index commits nothing, so the same root keeps serving the cached body.
async function refreshStagedIndex(
	read: () => ReviewState,
	git: GitPort,
	runMutation: Serializer,
	commit: (next: ReviewState) => void,
): Promise<void> {
	// Capture the root, then read the index mutex-free; the write below only runs when
	// the snapshot actually moved the staged bookkeeping.
	const observed = read()
	const snapshot = await readStagedSnapshot(observed, git)
	await runMutation(async () => {
		const live = read()
		// A commit landed while the index was being read: the snapshot was filtered
		// against the observed root's file set, so recompute against the live one
		// (rare - only when a mutation raced the read).
		const fresh =
			live === observed ? snapshot : await readStagedSnapshot(live, git)
		if (!stagedSnapshotMoved(live, fresh)) return
		commit({ ...live, ...fresh })
	})
}

// Both arrays come from the same git output in the same order on every read, so a positional
// compare is exact - and unlike a set compare it would still catch a genuine reorder.
function stagedSnapshotMoved(
	state: ReviewState,
	snapshot: {
		stagedFiles: readonly string[]
		stagedChangeKeys: readonly string[]
	},
): boolean {
	return (
		!samePaths(state.stagedFiles, snapshot.stagedFiles) ||
		!samePaths(state.stagedChangeKeys ?? [], snapshot.stagedChangeKeys)
	)
}

function samePaths(
	current: readonly string[],
	next: readonly string[],
): boolean {
	return (
		current.length === next.length &&
		current.every((path, index) => path === next[index])
	)
}
