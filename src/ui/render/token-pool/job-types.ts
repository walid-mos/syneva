import type { FileDiffMetadata, ThemedDiffResult } from '@pierre/diffs'
import type {
	ResolvedLanguage,
	WorkerRenderingOptions,
} from '@pierre/diffs/worker'
// Shapes the token pool's job book works with: the renderer it publishes into, the slot slice it
// dispatches onto, and the job/window records it keeps. Kept apart from job-board.ts because both
// halves of the book (scheduling, publishing) and the fleet all name these types.
import type { MergeGrid } from './merge'
import type { WorkerBaggage } from './protocol'
import type { WindowSpec } from './windows'

export type PublishRenderer = {
	onHighlightSuccess: (
		diff: FileDiffMetadata,
		result: ThemedDiffResult,
		options: WorkerRenderingOptions,
		highlighted?: boolean,
	) => void
}

export type WindowTask = {
	spec: WindowSpec
	status: 'queued' | 'sent' | 'done'
}
// One in-flight window dispatch, keyed by task id in the book's registry.
export type TaskEntry = { jobKey: string; spec: WindowSpec; sentAt: number }

export type TokenJob = {
	cacheKey: string
	diff: FileDiffMetadata
	options: WorkerRenderingOptions
	// The merge target (full plain skeleton + progressive token rows).
	merged: MergeGrid
	windows: WindowTask[]
	remaining: number
	instances: Set<PublishRenderer>
	languages: ResolvedLanguage[] | undefined
	publishFrame: number | undefined
	// A prefetch job: opened for a file the reviewer has not opened yet. It is dispatched on the slots
	// an attached job leaves free, capped to one viewport band, until a renderer attaches (which lifts
	// the cap and streams the rest of the file normally - the plan is complete either way).
	isWarm?: boolean
}

// The slot slice the book needs: it never boots or routes, it parks tasks. `attachedLanguages` is
// the worker's grammar set, so a job attaches a language once per worker instead of structured-
// cloning the grammar with every window dispatch.
export type SlotView = {
	worker: Worker
	openCacheKeys: Set<string>
	attachedLanguages: Set<string>
	// Baggage posts (open-diff, attach-languages) ride the fleet's control registry, so their acks
	// never free a slot that is still tokenizing (job-fleet.ts).
	send: (request: WorkerBaggage) => void
}
