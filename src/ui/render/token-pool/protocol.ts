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

// Tokenize ONE window of an open diff. The worker builds a structural slice (cloned hunks with
// context segments clipped to the window's slot range; no jsdiff and no re-parse) and replays
// @pierre's own iteration to recover which per-side content indexes the token rows belong to.
// resolvedLanguages ride along per task: workers never resolve grammar loaders themselves.
export type WorkerTokenWindow = {
	type: 'token-window'
	id: string
	cacheKey: string
	window: WindowSpec
	resolvedLanguages: ResolvedLanguage[]
}

export type WorkerRequest =
	| WorkerInitialize
	| WorkerSetRenderOptions
	| WorkerOpenDiff
	| WorkerTokenWindow

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
}

export type WorkerSuccess =
	| { type: 'success'; requestType: 'initialize'; id: string }
	| { type: 'success'; requestType: 'set-render-options'; id: string }
	| { type: 'success'; requestType: 'open-diff'; id: string }
	| WorkerTokenWindowSuccess

export type WorkerFailure = {
	type: 'error'
	id: string
	error: string
	stack?: string
}

export type WorkerResponse = WorkerSuccess | WorkerFailure
