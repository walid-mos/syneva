import { WORKER_URL } from './worker-pool'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { ParseInput } from './parse-input'
import type { WorkerParseDiff, WorkerResponse } from './token-pool/protocol'

// The prefetch's parse, off the main thread. The parse is the only size-dependent step on the click path
// (measured 187 ms at 3 700 lines, 1 339 ms on a full rewrite) and the prefetch is fire-and-forget, so the
// work itself can leave the main thread: the click that follows adopts the result from the memo
// (diff-metadata.ts seedPrefetchedMetadata) instead of paying for it while the reviewer waits for rows.
//
// A DEDICATED worker on the pool's own script, not a pool job. A parse needs neither themes nor grammars
// (so it answers before any initialize), and above all a pool worker would carry the prefetch's parse in
// front of the visible file's tokenize windows - the one queue this must never touch. One extra worker
// instance is the whole cost, and it is only created once a file is big enough to jank the main thread.

// Below this many characters of old+new side the parse is a few milliseconds (5 ms at 400 lines, 32 ms at
// 1 500), so offloading it would buy nothing and pay a clone and a worker round-trip on every pass.
const OFFLOAD_MIN_CHARS = 48_000

let worker: Worker | undefined
let nextId = 1
const pending = new Map<string, (diff: FileDiffMetadata | undefined) => void>()

// undefined means "no offload": either this file is too small to be worth it, or the worker is unavailable
// or failed. The caller then keeps today's main-thread parse, so this path can only ever remove work from
// the click, never add a wait to it.
export function parseOffThread(
	input: ParseInput,
): Promise<FileDiffMetadata | undefined> {
	if (input.oldContents.length + input.newContents.length < OFFLOAD_MIN_CHARS)
		return Promise.resolve(undefined)
	const parseWorker = ensureWorker()
	if (!parseWorker) return Promise.resolve(undefined)
	const id = String(nextId++)
	return new Promise(resolve => {
		pending.set(id, resolve)
		parseWorker.postMessage({
			type: 'parse-diff',
			id,
			input,
		} satisfies WorkerParseDiff)
	})
}

function ensureWorker(): Worker | undefined {
	if (worker) return worker
	if (typeof Worker === 'undefined') return undefined
	worker = new Worker(WORKER_URL, { type: 'module' })
	worker.addEventListener('message', event => {
		// The seam where a worker message is typed: no runtime validation, since the sender is our own
		// script - which is exactly why this file sits in oxlint.config.ts's worker-message override.
		const response = event.data as WorkerResponse
		if (response.type === 'error') return settle(response.id, undefined)
		// The early return above already narrowed the union to its successes.
		if (response.requestType === 'parse-diff')
			settle(response.id, response.diff)
	})
	// A worker that dies (script fetch failure, out of memory) must not leave prefetches waiting: drop it
	// and settle everything in flight as "no offload", which falls back to the main-thread parse.
	worker.addEventListener('error', () => {
		for (const id of pending.keys()) settle(id, undefined)
		worker?.terminate()
		worker = undefined
	})
	return worker
}

function settle(id: string, diff: FileDiffMetadata | undefined): void {
	const resolve = pending.get(id)
	if (!resolve) return
	pending.delete(id)
	resolve(diff)
}
