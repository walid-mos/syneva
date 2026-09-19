// Wire shapes between the token-pool manager (main thread) and diff-token workers. Type-only
// module (erased by esbuild): the runtime boundary between the two worlds must not leak code.
import type {
	FileDiffMetadata,
	ThemeRegistrationResolved,
	ThemedDiffResult,
} from '@pierre/diffs'
import type {
	ResolvedLanguage,
	WorkerRenderingOptions,
} from '@pierre/diffs/worker'
import type { ParseInput } from '../parse-input'
import type { WindowPositions } from './merge'
import type { WindowSpec } from './windows'

// Worker bootstrap: attach themes/langs as RESOLVED shiki data (the same payload @pierre's own
// pool composes on the main thread by loading syneva's curated grammars) and pin the render
// options both sides agree on from then on.
export type WorkerInitialize = {
	type: 'initialize'
	id: string
	renderOptions: WorkerRenderingOptions
	resolvedThemes: ThemeRegistrationResolved[]
	resolvedLanguages: ResolvedLanguage[]
}

// Fresh global token settings (theme/lineDiffType edits). Messages process in order per worker,
// so tasks queued after this one run under the new options.
export type WorkerSetRenderOptions = {
	type: 'set-render-options'
	id: string
	renderOptions: WorkerRenderingOptions
	resolvedThemes: ThemeRegistrationResolved[]
}

// A parsed diff handed ONCE per worker per job (structured clone of syneva's FileDiffMetadata).
// Window tasks reference it by cacheKey instead of re-posting megabytes of parsed content.
export type WorkerOpenDiff = {
	type: 'open-diff'
	id: string
	cacheKey: string
	diff: FileDiffMetadata
}

// Attach grammars to a worker ONCE (job-board's attachLanguages), instead of structured-cloning
// the grammar data with every window dispatch. Ordered before the window that needs it, so the
// worker never has to wait on it.
export type WorkerAttachLanguages = {
	type: 'attach-languages'
	id: string
	languages: ResolvedLanguage[]
}

// Tokenize ONE window of an open diff. The worker builds a structural slice (cloned hunks with
// context segments clipped to the window's slot range; no jsdiff and no re-parse) and replays
// @pierre's own iteration to recover which per-side content indexes the token rows belong to.
type WorkerTokenWindow = {
	type: 'token-window'
	id: string
	cacheKey: string
	window: WindowSpec
}

export type WorkerRequest =
	| WorkerInitialize
	| WorkerSetRenderOptions
	| WorkerOpenDiff
	| WorkerAttachLanguages
	| WorkerTokenWindow
	| WorkerParseDiff

// Requests the pool posts without awaiting a task result: the worker replies with a plain ack,
// so they are baggage for the slot that carries them (job-fleet.ts registers them, or their acks
// would free a worker that is still tokenizing).
export type WorkerBaggage =
	| Omit<WorkerOpenDiff, 'id'>
	| Omit<WorkerAttachLanguages, 'id'>

// Worker-side stage costs of ONE window task, in ms, so the manager can attribute the latency
// between dispatch and merge (slice build vs tokenization) without guessing. `rows` is the number
// of token lines the window actually produced (both sides), which is what `tokenize` scales with -
// without it a slow window cannot be attributed to size or to contention.
export type WorkerTimings = {
	rows: number
	slice: number
	tokenize: number
}

export type WorkerTokenWindowSuccess = {
	type: 'success'
	requestType: 'token-window'
	id: string
	cacheKey: string
	window: WindowSpec
	code: ThemedDiffResult['code']
	positions: WindowPositions
	themeStyles: ThemedDiffResult['themeStyles']
	baseThemeType: ThemedDiffResult['baseThemeType']
	options: WorkerRenderingOptions
	timings: WorkerTimings
}

export type WorkerSuccess =
	| { type: 'success'; requestType: 'initialize'; id: string }
	| { type: 'success'; requestType: 'set-render-options'; id: string }
	| { type: 'success'; requestType: 'open-diff'; id: string }
	| { type: 'success'; requestType: 'attach-languages'; id: string }
	| WorkerTokenWindowSuccess
	| WorkerParseDiffSuccess

// The prefetch's parse, run off the main thread (render/parse-offload.ts). Self-contained by design: no
// initialize, no cacheKey, no job - a DEDICATED worker instance on this same script answers it, so the
// pool's job accounting and the visible file's window queue are untouched by a prefetch.
// The inputs are parse-input.ts's, i.e. exactly the ones the main-thread parse would use.
export type WorkerParseDiff = {
	type: 'parse-diff'
	id: string
	input: ParseInput
}

export type WorkerParseDiffSuccess = {
	type: 'success'
	requestType: 'parse-diff'
	id: string
	diff: FileDiffMetadata
}

export type WorkerFailure = {
	type: 'error'
	id: string
	error: string
	stack?: string
}

export type WorkerResponse = WorkerSuccess | WorkerFailure
