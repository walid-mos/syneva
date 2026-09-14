import { currentFileOrNull } from './changes'
import { restoreComposerFocus } from './composer'
import { cur, loadCurrentContents, peekContents } from './contents'
import { cursorReset } from './cursor'
import { isMarkdownPath } from './file-summary'
import { hasGuide, renderOverview } from './guide'
import { renderMarkdownFile } from './mdfile'
import { isOversizedPlaceholder, renderOversizedCard } from './oversized'
import { updateProgress } from './progress'
import { diffKey, renderDiffInstance } from './render/diff-instance'
import { isExpandCapped, newLines } from './render/expand-cap'
import { clearOverviewRuler } from './render/overview-ruler'
import {
	fileMovedPure,
	isFileSkimCollapsed,
	renderFileSkim,
	renderMovedPure,
} from './skim'
import { $, D, esc, S } from './store'
import { applyActiveRow, applyLayoutClasses } from './tree'

import type { DiffView } from './render/diff-instance'
import type { ReviewState } from './types'

type ReviewFile = ReviewState['files'][number]

// The current render's view flags, read from the store (see DiffView). The expand-unchanged
// preference is respected only under the whole-file paint cap: past EXPAND_LINES_MAX the diff
// renders hunks-only and the header notes the cap (file-header.ts), so a 10k-line file can't
// storm the tab with tens of thousands of DOM cells - every render pass rebuilds synchronously.
function currentView(): DiffView {
	const wantsExpand = S.settings.unchangedLines === 'expand'
	return {
		isPreviewing: !!S.preview,
		isExpandedUnchanged: wantsExpand && !isExpandCapped(cur.newContents),
	}
}

// The render pass: the single function every progress-moving mutation funnels through, plus the
// gate that decides what #diff shows for the current file. The diff itself is rendered by the
// @pierre island (render/diff-instance.ts); the header builders live in render/file-header.ts.

// A diff that would block longer than ~this many lines of tokenization shows the indicator.
const RENDER_INDICATOR_MIN_LINES = 400

// Run render() but first paint a "Rendering…" indicator when the current file is big enough to
// block on tokenization - used by file switches and Reset (both can re-tokenize). The double rAF
// is required: the indicator must paint *before* the synchronous Shiki work begins.
// `isForcedIfBig` shows it for any big file (Reset re-tokenizes even when the diff key is cached);
// otherwise a fast cached re-open skips the badge to avoid an appear-then-vanish flash.
export function deferRender(isForcedIfBig = false): void {
	const file = currentFileOrNull()
	const view = currentView()
	// Contents arrive via a per-file fetch (see contents.ts). When they aren't warm yet the upcoming
	// render() gates on that fetch, so show the indicator; when they are, decide on size as before.
	// peekContents never fetches, so this stays synchronous.
	const warm = file ? peekContents(file) : null
	const isBig =
		!!warm &&
		Math.max(newLines(warm.oldContents), newLines(warm.newContents)) >
			RENDER_INDICATOR_MIN_LINES
	// A cached diff key means the coming render re-mounts an existing instance: no tokenizing.
	const reusesCache =
		!!file && !isForcedIfBig && D.diffCache.has(diffKey(file, view))
	S.rendering = !!file && (!warm || (isBig && !reusesCache))
	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			void (async () => {
				try {
					await render()
				} finally {
					S.rendering = false
				}
			})()
		}),
	)
}

// Detach the active diff instance - its cached wrapper survives in D.diffCache, so returning to
// the file re-mounts it - and drop the display line map. A replacement view owns #diff from here.
function detachDiffInstance(): void {
	D.instance = null
	D.lineMap = null
}

// Guided review: the Overview page takes over the center until a file is selected.
function renderGuideOverview(): boolean {
	if (!(S.overviewOpen && hasGuide())) return false
	cursorReset()
	detachDiffInstance()
	renderOverview()
	return true
}

// An oversized file (server-stamped) paints a verdict-capable summary card instead of its diff -
// before the contents fetch, so opening it never blocks on a multi-MB tokenization pass.
// "Load diff anyway" (oversized.ts) clears the placeholder and falls back to the normal render.
function renderOversizedSummary(): void {
	cursorReset()
	detachDiffInstance()
	applyLayoutClasses()
	renderOversizedCard()
}

// Shown when a file's contents can't be fetched (git object gone after a rebase, transport
// failure). Names the file and points at a desk reload; the rest of the desk stays live, so the
// reviewer can navigate to other files while this one is unresolvable.
function renderContentsError(path: string): void {
	cursorReset()
	detachDiffInstance()
	applyLayoutClasses()
	$('diff').innerHTML =
		`<div class="file-skim"><div class="file-skim-strip moved">
    <svg class="ic"><use href="#gly-flag"></use></svg>
    <span>couldn't load <span class="file-skim-name">${esc(path)}</span></span>
    <span class="file-skim-meta">reload the desk to retry</span>
  </div></div>`
}

// Which replacement view (if any) takes over #diff for this file, after the contents fetch - none
// of them read the contents, but the fetch still warms the per-file cache for a later switch.
type ReplacementView = 'markdown' | 'moved' | 'skim'

function replacementView(
	file: ReviewFile,
	isPreviewing: boolean,
): ReplacementView | null {
	// Markdown file in rendered mode: formatted preview with block-anchored comments instead of the
	// @pierre/diffs view.
	if (
		!isPreviewing &&
		S.state?.mode === 'file' &&
		isMarkdownPath(file.path) &&
		S.fileView === 'rendered'
	)
		return 'markdown'
	// A pure rename (identical content, distinct paths) has no diff to show - the muted
	// "renamed old -> new, no changes" row replaces it.
	if (!isPreviewing && fileMovedPure(file.path)) return 'moved'
	// A skim-flagged file collapses its whole diff behind one expandable strip (guide-driven,
	// display only). Expanding drops back to the normal render.
	if (!isPreviewing && isFileSkimCollapsed(file.path)) return 'skim'
	return null
}

function renderReplacementView(
	file: ReviewFile,
	isPreviewing: boolean,
): boolean {
	const view = replacementView(file, isPreviewing)
	if (!view) return false
	cursorReset()
	detachDiffInstance()
	applyLayoutClasses()
	if (view === 'markdown') renderMarkdownFile()
	else if (view === 'moved') renderMovedPure()
	else renderFileSkim()
	return true
}

async function renderCenter(): Promise<void> {
	clearOverviewRuler()
	if (renderGuideOverview()) return
	const file = currentFileOrNull()
	// Nothing to show: the pre-init window (main.ts hasn't adopted the first fetch yet), or a reload
	// whose rebuilt review came back empty. Empty the pane rather than render a fabricated file.
	if (!file) {
		cursorReset()
		detachDiffInstance()
		applyLayoutClasses()
		$('diff').replaceChildren()
		return
	}
	const isPreviewing = !!S.preview
	if (!isPreviewing && isOversizedPlaceholder(file)) {
		renderOversizedSummary()
		return
	}
	// Pull this file's contents from the per-file endpoint before rendering anything that reads
	// them (the markdown/moved/skim/diff views all follow). A "stale" result means the reviewer
	// switched files mid-fetch - abort silently, a newer render() is already handling the current
	// file. An "error" means the contents can't be fetched (git object gone after a rebase); show an
	// error card naming the file so navigation to other files keeps working.
	const contentsStatus = await loadCurrentContents()
	if (contentsStatus === 'stale') return
	if (contentsStatus === 'error') {
		renderContentsError(file.path)
		return
	}
	if (renderReplacementView(file, isPreviewing)) return
	applyLayoutClasses()
	renderDiffInstance(file, currentView())
}

// Every progress-moving mutation (decision, approval, reset, reload) funnels through render,
// so it is the progress strip's single repaint point. It must run AFTER the render work has
// PAINTED, not merely after renderCenter returns: the transition clock starts at style-commit,
// and a file switch's first frame is spent tokenizing + laying out the new diff DOM - a bar
// started before (or during) that frame lands already-finished, i.e. no visible motion. The
// double rAF puts the width change on the first idle frame after that paint.
export async function render(): Promise<void> {
	try {
		await renderCenter()
	} finally {
		// The diff DOM (and any inline composer inside it) was just rebuilt from scratch - re-focus
		// the open composer and restore its caret from the store, so typing survives a render
		// triggered mid-compose (e.g. accepting a change while replying).
		restoreComposerFocus()
		// Re-apply the sidebar highlight an rAF later - after Alpine's microtask flush, so rows
		// that were just re-keyed by a reactive change carry it again (see applyActiveRow).
		requestAnimationFrame(applyActiveRow)
		requestAnimationFrame(() => requestAnimationFrame(updateProgress))
	}
}
