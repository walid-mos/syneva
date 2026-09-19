import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WindowDispatch } from './window-dispatch'

import type { FileDiffMetadata } from '@pierre/diffs'
import type {
	ResolvedLanguage,
	WorkerRenderingOptions,
} from '@pierre/diffs/worker'
import type {
	PublishRenderer,
	SlotView,
	TaskEntry,
	TokenJob,
} from './job-types'
import type { MergeGrid } from './merge'
import type { WorkerRequest } from './protocol'
import type { WindowSpec } from './windows'

// Only the two facts scheduling reads off a window are builder-controlled here: its startingLine
// (so an assertion can name the window) and its queued status.
const spec = (startingLine: number): WindowSpec => ({
	kind: 'sweep',
	startingLine,
	totalLines: 10,
	firstHunk: 0,
	lastHunk: 0,
})

const ATTACHED: PublishRenderer = { onHighlightSuccess: () => {} }
const LANGUAGES: ResolvedLanguage[] = [
	{ name: 'typescript' } as ResolvedLanguage,
]

type JobOptions = { isAttached?: boolean; isWarm?: boolean }

const job = (
	cacheKey: string,
	windowCount: number,
	{ isAttached = false, isWarm = false }: JobOptions = {},
): TokenJob => ({
	cacheKey,
	// The diff only ever gets forwarded (and described in the open-diff mark), never read for rows.
	diff: {
		cacheKey,
		splitLineCount: windowCount * 10,
		hunks: [],
	} as unknown as FileDiffMetadata,
	options: {} as WorkerRenderingOptions,
	merged: {} as MergeGrid,
	windows: Array.from({ length: windowCount }, (_, index) => ({
		spec: spec(index * 10),
		status: 'queued' as const,
	})),
	remaining: windowCount,
	instances: isAttached ? new Set([ATTACHED]) : new Set(),
	languages: LANGUAGES,
	publishFrame: undefined,
	isWarm,
})

// A pool of `free` slots, each parked on its own message log: idleSlot hands out one slot per
// dispatch (the fleet owns busy/release in production, the dispatcher only asks who is free). `cap` is
// the dispatcher's warm-window cap - the pool width in production (one viewport band, windows.ts).
const drainWith = (jobs: TokenJob[], free: number, cap = 4): string[] => {
	const dispatched: string[] = []
	const slots: SlotView[] = Array.from({ length: free }, () => ({
		worker: {
			postMessage: (request: WorkerRequest) => {
				if (request.type === 'token-window')
					dispatched.push(request.cacheKey)
			},
		} as unknown as Worker,
		openCacheKeys: new Set<string>(),
		attachedLanguages: new Set<string>(),
		send: () => {},
	}))
	const registry = new Map(jobs.map(entry => [entry.cacheKey, entry]))
	const dispatch = new WindowDispatch(
		() => slots.shift(),
		registry,
		new Map<string, TaskEntry>(),
		cap,
	)
	dispatch.drain()
	return dispatched
}

// The reviewer's file has a renderer attached; the other one is a file the reviewer has left - still
// open, its remaining windows queued, nobody looking at them.
const attached = (): TokenJob => job('attached', 1, { isAttached: true })
const abandoned = (): TokenJob => job('abandoned', 3)

// `assert.deepEqual` is an assertion function (`asserts actual is T`). Comparing two values of the same
// type leaves nothing to narrow, and the type-aware lint reads that vacuous predicate as a redundant
// condition - so a comparison hands in the unknown value a deep comparison really takes.

void test('a free slot goes to the attached job before an abandoned one', () => {
	const actual: unknown = drainWith([abandoned(), attached()], 1)
	assert.deepEqual(actual, ['attached'])
})

// The measured waste this rule removes: an abandoned 8000-line job held every worker for ~26 s.
void test('slots the attached job leaves free stay free for it, not for abandoned work', () => {
	const actual: unknown = drainWith([abandoned(), attached()], 4)
	assert.deepEqual(actual, ['attached'])
})

void test('nothing is dispatched while no renderer is attached', () => {
	assert.deepEqual(drainWith([job('first', 1), job('second', 1)], 2), [])
})

// A prefetch (job-board.openJob's `isWarm` job): nobody is looking at it yet, so it moves ONLY while the
// reviewer's own file has no window left to send, and it never takes the whole pool - one slot is kept
// free for the next click. `landed` windows are what a drain sees once a band has come back from the
// workers (the cap counts landed color, not dispatched windows).
const warm = (landed: number, queued: number): TokenJob => ({
	...job('warm', landed + queued, { isWarm: true }),
	windows: Array.from({ length: landed + queued }, (_, index) => ({
		spec: spec(index * 10),
		status: index < landed ? ('done' as const) : ('queued' as const),
	})),
})

// The reviewer's file mid-stream: a prefetch must not touch these slots.
void test('a prefetch waits while the attached job still has windows to send', () => {
	const actual: unknown = drainWith(
		[warm(0, 5), job('reader', 4, { isAttached: true })],
		3,
	)
	assert.deepEqual(actual, ['reader', 'reader', 'reader'])
})

// The measured failure this rule removes: after a few navigations the accumulated prefetch bands held
// every worker, and the next click painted 3.5 s late instead of ~0.5 s.
void test('a prefetch resumes once the attached job has nothing queued', () => {
	const actual: unknown = drainWith([warm(0, 5), attached()], 2, 2)
	assert.deepEqual(actual, ['attached', 'warm'])
})

// One slot of the pool is always the reviewer's: a prefetch under this budget can never occupy the
// whole pool, whatever is idle.
void test('a prefetch never takes the whole pool', () => {
	const actual: unknown = drainWith([warm(0, 5)], 4, 3)
	assert.deepEqual(actual, ['warm', 'warm'])
})

// Only the newest prefetch runs: older ones belong to files the reviewer has walked past.
void test('only the newest prefetch is dispatched', () => {
	const older = { ...warm(0, 4), cacheKey: 'older' }
	const actual: unknown = drainWith([older, warm(0, 4)], 4, 4)
	assert.deepEqual(actual, ['warm', 'warm', 'warm'])
})

void test('a warm job stops once one band has landed, even with slots free', () => {
	const actual: unknown = drainWith([warm(2, 3), attached()], 3, 2)
	assert.deepEqual(actual, ['attached'])
})

void test('the band cap does not apply once a renderer is attached', () => {
	const actual: unknown = drainWith(
		[job('busy', 4, { isAttached: true })],
		4,
		1,
	)
	assert.deepEqual(actual, ['busy', 'busy', 'busy', 'busy'])
})
