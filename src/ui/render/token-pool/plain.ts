// Main-thread highlighter side of the token pool: the pinned pool keeps its OWN main-thread
// shiki instance to answer getPlainDiffAST synchronously (the renderer renders plain rows while
// worker tokens are in flight); this module owns that highlighter plus the option plumbing the
// manager and the workers must agree on. Grammar/theme LOADERS resolve on this thread (through
// the shiki-shim's curated registry) - workers only ever receive resolved data.
import {
	getResolvedLanguages,
	getResolvedThemes,
	getSharedHighlighter,
	getFiletypeFromFileName,
	getThemes,
	hasResolvedLanguages,
	hasResolvedThemes,
	resolveLanguages,
	resolveThemes,
	renderDiffWithHighlighter,
} from '@pierre/diffs'

import { perfSpan } from '../../perf'

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

export type TokenRenderOptions = WorkerRenderingOptions

export const DEFAULT_TOKEN_OPTIONS: TokenRenderOptions = {
	theme: { dark: 'pierre-dark', light: 'pierre-light' },
	useTokenTransformer: false,
	lineDiffType: 'word-alt',
	maxLineDiffLength: 1_000,
	tokenizeMaxLineLength: 1_000,
}

let mainHighlighter: DiffsHighlighter | undefined

export function plainHighlighter(): DiffsHighlighter | undefined {
	return mainHighlighter
}

// Boot/adopt path: themes resolve here (sync when previously resolved, async once), then the
// shared highlighter attaches them before any plain render - getPlainDiffAST callers expect a
// synchronous result, so this must have settled before the first one.
export function ensurePlainHighlighter(
	options: TokenRenderOptions,
): Promise<DiffsHighlighter> {
	return (async () => {
		const endBoot = perfSpan('pool:highlighter')
		const themeNames = getThemes(options.theme)
		const resolvedThemes = hasResolvedThemes(themeNames)
			? getResolvedThemes(themeNames)
			: await resolveThemes(themeNames)
		const boot = await getSharedHighlighter({
			themes: themeNames,
			langs: [],
			preferredHighlighter: 'shiki-js',
		})
		for (const theme of resolvedThemes) boot.loadThemeSync(theme)
		mainHighlighter = boot
		endBoot()
		return boot
	})()
}

export async function resolvedThemesFor(
	options: TokenRenderOptions,
): Promise<ThemeRegistrationResolved[]> {
	const themeNames = getThemes(options.theme)
	if (hasResolvedThemes(themeNames)) return getResolvedThemes(themeNames)
	return resolveThemes(themeNames)
}

// Synchronous plain render of a whole diff: every slot row (expandedHunks=true covers every
// expansion state), no word-diff spans, "text" language override. Measured ~37 ms at 16k lines -
// the pinned architecture pays per-render-pass plain renders instead; ours pays once per job and
// reuses the grid as the merge skeleton.
export function renderPlainResult(
	diff: FileDiffMetadata,
	options: TokenRenderOptions,
): ThemedDiffResult | undefined {
	const highlighter = plainHighlighter()
	if (!highlighter) return undefined
	const endSpan = perfSpan('pool:plain')
	const plainGrid = renderDiffWithHighlighter(diff, highlighter, options, {
		forcePlainText: true,
		expandedHunks: true,
	})
	endSpan({ lines: diff.splitLineCount })
	return plainGrid
}

export async function resolveLanguagesFor(
	diff: FileDiffMetadata,
): Promise<ResolvedLanguage[]> {
	const names = languageNames(diff)
	const missing = names.filter(name => !hasResolvedLanguages([name]))
	if (missing.length > 0) {
		// Chunk fetch + grammar registration: the long half, and the reason the resolve is started
		// before the worker boot (see pool.ts's prewarmLanguages).
		const endLoad = perfSpan('pool:languages:load')
		await resolveLanguages(missing)
		endLoad({ missing: missing.length })
	}
	const endRead = perfSpan('pool:languages')
	const resolved = getResolvedLanguages(names)
	endRead({ count: resolved.length, missing: missing.length })
	return resolved
}

// The grammars a diff tokenizes under, through @pierre's own filename mapping (alias tables
// included), exactly what its pool derives per task. 'text' never resolves - the worker treats
// it as plain.
function languageNames(diff: FileDiffMetadata): string[] {
	const derived = [diff.prevName ?? diff.name, diff.name].map(name =>
		getFiletypeFromFileName(name),
	)
	return [...new Set(derived.filter(name => name !== 'text'))]
}

// The plain-text gate kept from @pierre's own pool (isDiffPlainText isn't exported from the
// package root at this pin): diffs whose both sides are 'text' never schedule token work.
export function isPlainDiff(diff: FileDiffMetadata): boolean {
	const lang = diff.lang ?? getFiletypeFromFileName(diff.name)
	const previousLang = diff.lang ?? fileLanguage(diff.prevName ?? '', 'text')
	return lang === 'text' && previousLang === 'text'
}

function fileLanguage(name: string, fallback: string): string | undefined {
	return name ? getFiletypeFromFileName(name) : fallback
}
