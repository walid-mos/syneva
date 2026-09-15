import { renderDiffWithHighlighter } from '@pierre/diffs'
// Galley's own tokenization worker entry. @pierre's worker script tokenizes a whole diff per
// task (~2 ms per line-unit; a 16k-line file costs tens of seconds in one structured clone);
// this one splits a diff into windows (a task carries a slot range plus its hunk slice),
// builds the structural slice (hunk clones, context segments clipped - no jsdiff, no re-parse)
// and walks the emitted segments for each token row's per-side content index. The manager
// merges those rows into a full plain skeleton (render/token-pool/merge.ts).
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

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
			case 'token-window':
				return forWindow(request)
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
	// galley's curated shim and ships the result) - no language loader ever runs worker-side.
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

async function forWindow(
	request: Extract<WorkerRequest, { type: 'token-window' }>,
): Promise<void> {
	const options = renderOptions
	const shiki = highlighter
	if (!options || !shiki)
		throw new Error(
			'token-window: worker has no adopted render options yet',
		)
	attachLanguages(shiki, request.resolvedLanguages)
	const diff = openDiffs.get(request.cacheKey)
	if (!diff)
		throw new Error(
			`token-window: no open diff for cacheKey "${request.cacheKey}"`,
		)
	const sliced = buildSlice(diff, request.window)
	// Cast: @pierre types the parameter against the full shiki barrel; the lean shiki/core
	// instance exposes the same runtime surface this call touches.
	const tokenized = renderDiffWithHighlighter(
		sliced.slice,
		shiki as unknown as DiffsHighlighter,
		options,
	)
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
	})
}
