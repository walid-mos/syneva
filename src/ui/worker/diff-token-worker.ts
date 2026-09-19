import { renderDiffWithHighlighter } from '@pierre/diffs'
// Syneva's own tokenization worker entry. @pierre's worker script tokenizes a whole diff per
// task (~2 ms per line-unit; a 16k-line file costs tens of seconds in one structured clone);
// this one splits a diff into windows (a task carries a slot range plus its hunk slice),
// builds the structural slice (hunk clones, context segments clipped - no jsdiff, no re-parse)
// and walks the emitted segments for each token row's per-side content index. The manager
// merges those rows into a full plain skeleton (render/token-pool/merge.ts).
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import { parseFileDiff } from '../render/parse-input'

import { buildSlice } from './slice'

import type {
	DiffsHighlighter,
	FileDiffMetadata,
	ThemeRegistrationResolved,
	ThemedDiffResult,
} from '@pierre/diffs'
import type {
	ResolvedLanguage,
	WorkerRenderingOptions,
} from '@pierre/diffs/worker'
import type { HighlighterCore } from 'shiki/core'
import type {
	WorkerFailure,
	WorkerParseDiff,
	WorkerParseDiffSuccess,
	WorkerRequest,
	WorkerResponse,
	WorkerSuccess,
} from '../render/token-pool/protocol'
import type { WindowSpec } from '../render/token-pool/windows'
import type { WindowPositions } from './slice'

// DOM libs type `self` as Window; the narrow view gives module-worker semantics (casts are
// file-level-disabled in oxlint.config.ts).
const scope = self as unknown as {
	addEventListener: (
		type: 'message',
		listener: (event: MessageEvent<WorkerRequest>) => void,
	) => void
	postMessage: (message: WorkerResponse) => void
}

let highlighter: HighlighterCore | undefined
let renderOptions: WorkerRenderingOptions | undefined

const OPEN_DIFF_CAP = 6
const openDiffs = new Map<string, FileDiffMetadata>()

scope.addEventListener('message', event => {
	// Async because adoption awaits the first highlighter creation; worker messages still run
	// sequentially, so a queued token-window can never overtake its adoption.
	void run(event.data)
})

async function run(request: WorkerRequest): Promise<void> {
	try {
		switch (request.type) {
			case 'initialize':
				await adoptRenderOptions(
					request.renderOptions,
					request.resolvedThemes,
					request.resolvedLanguages,
				)
				break
			case 'set-render-options':
				await adoptRenderOptions(
					request.renderOptions,
					request.resolvedThemes,
					[],
				)
				break
			case 'open-diff':
				rememberDiff(request.cacheKey, request.diff)
				break
			// Grammars arrive once per worker (job-board's attachLanguages) instead of riding every
			// window dispatch: a window is posted right after its attach, in message order.
			case 'attach-languages':
				attachLanguages(
					requireHighlighter('attach-languages'),
					request.languages,
				)
				break
			case 'token-window':
				return forWindow(request)
			case 'parse-diff':
				return forParseDiff(request)
		}
		post({ type: 'success', requestType: request.type, id: request.id })
	} catch (error) {
		scope.postMessage({
			type: 'error',
			id: request.id,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		} satisfies WorkerFailure)
	}
}

// The prefetch's off-thread parse (render/parse-offload.ts): the very same call the main thread makes
// (render/parse-input.ts), posted back as a structured clone of the metadata - `open-diff` already proves
// that payload survives the boundary in the other direction.
function forParseDiff(request: WorkerParseDiff): void {
	scope.postMessage({
		type: 'success',
		requestType: 'parse-diff',
		id: request.id,
		diff: parseFileDiff(request.input),
	} satisfies WorkerParseDiffSuccess)
}

// renderDiffWithHighlighter's row order (bucket concatenation, ascending content indexes per
// side) matches the walk's emitted sequence: assert, don't trust (drift shuffles rows).
function assertRowAlignment(
	window: WindowSpec,
	tokenized: ThemedDiffResult,
	positions: WindowPositions,
): void {
	const sides = [
		[
			'deletion',
			tokenized.code.deletionLines.length,
			positions.deletion.length,
		],
		[
			'addition',
			tokenized.code.additionLines.length,
			positions.addition.length,
		],
	] as const
	for (const [side, rows, walked] of sides)
		if (rows !== walked)
			throw new Error(
				`token-window: ${side} rows=${rows} walked=${walked} for ${window.kind} window @${window.startingLine}`,
			)
}

function rememberDiff(cacheKey: string, diff: FileDiffMetadata): void {
	if (!openDiffs.delete(cacheKey) && openDiffs.size >= OPEN_DIFF_CAP) {
		// FIFO past the cap: evict the oldest key; four workers under LPT keep few jobs live
		// and each parsed clone is megabytes.
		const oldest = openDiffs.keys().next().value
		if (oldest) openDiffs.delete(oldest)
	}
	openDiffs.set(cacheKey, diff)
}

function post(message: WorkerSuccess): void {
	scope.postMessage(message)
}

async function adoptRenderOptions(
	options: WorkerRenderingOptions,
	themes: ThemeRegistrationResolved[],
	languages: ResolvedLanguage[],
): Promise<void> {
	highlighter ??= await createHighlighterCore({
		langs: [],
		themes: [],
		engine: createJavaScriptRegexEngine(),
	})
	// The worker only ever loads RESOLVED data (the manager resolves theme/grammar JSON through
	// syneva's curated shim and ships the result) - no language loader ever runs worker-side.
	for (const theme of themes) highlighter.loadThemeSync(theme)
	attachLanguages(highlighter, languages)
	renderOptions = options
}

// Idempotent grammar attach: shiki re-syncs on every loadLanguageSync, so a task's repeated
// payloads cost nothing after the first window of that language.
const attachedLanguages = new Set<string>()
function attachLanguages(
	shiki: HighlighterCore,
	languages: ResolvedLanguage[],
): void {
	for (const language of languages) {
		if (attachedLanguages.has(language.name)) continue
		shiki.loadLanguageSync(language.data)
		attachedLanguages.add(language.name)
	}
}

// Grammar and options arrive in separate messages, so both handlers must refuse to run before
// initialize landed rather than tokenize against a half-adopted worker.
function requireHighlighter(action: string): HighlighterCore {
	if (highlighter) return highlighter
	throw new Error(`${action}: worker is not initialized`)
}

// Sub-millisecond stage costs matter here (a window tokenizes in single-digit ms), so report tenths.
const TENTHS_PER_MS = 10
function tenths(ms: number): number {
	return Math.round(ms * TENTHS_PER_MS) / TENTHS_PER_MS
}

async function forWindow(
	request: Extract<WorkerRequest, { type: 'token-window' }>,
): Promise<void> {
	const options = renderOptions
	const shiki = requireHighlighter('token-window')
	if (!options)
		throw new Error(
			'token-window: worker has no adopted render options yet',
		)
	const diff = openDiffs.get(request.cacheKey)
	if (!diff)
		throw new Error(
			`token-window: no open diff for cacheKey "${request.cacheKey}"`,
		)
	const startSlice = performance.now()
	const sliced = buildSlice(diff, request.window)
	const sliceMs = performance.now() - startSlice
	// Cast: @pierre types the parameter against the full shiki barrel; the lean shiki/core
	// instance exposes the same runtime surface this call touches.
	const startTokenize = performance.now()
	const tokenized = renderDiffWithHighlighter(
		sliced.slice,
		shiki as unknown as DiffsHighlighter,
		options,
	)
	const tokenizeMs = performance.now() - startTokenize
	assertRowAlignment(request.window, tokenized, sliced.positions)
	post({
		type: 'success',
		requestType: 'token-window',
		id: request.id,
		cacheKey: request.cacheKey,
		window: request.window,
		code: tokenized.code,
		positions: sliced.positions,
		themeStyles: tokenized.themeStyles,
		baseThemeType: tokenized.baseThemeType,
		options,
		timings: {
			rows:
				sliced.positions.deletion.length +
				sliced.positions.addition.length,
			slice: tenths(sliceMs),
			tokenize: tenths(tokenizeMs),
		},
	})
}
