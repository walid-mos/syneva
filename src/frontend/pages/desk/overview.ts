import { guideStale } from '@entities/review/guide/guide'
import { $ } from '@shared/lib/dom'
import { esc } from '@shared/lib/esc'

import { deskCtx } from './context'

import type { GuideInputs } from '@entities/review/guide/guide'

// The guide derivations' explicit inputs, read from the store at each evaluation.
const GI = (): GuideInputs => ({
	state: deskCtx().S.state,
	fileIndex: deskCtx().S.fileIndex,
	hideReviewed: deskCtx().S.settings.hideReviewed,
	progressBy: deskCtx().S.settings.progressBy,
	foldExpanded: deskCtx().S.foldExpanded,
})

// The Overview page: the guided review's landing card. It takes over #diff until a file is
// selected (see pages/desk/render.ts's renderGuideOverview). No file list - the sidebar
// (tree/walkthrough) already lists every file, so repeating them here was redundant - and no
// agent prose: a grouping is labels and order only.

// Render the landing card into #diff: what this review is, a note when the grouping predates
// the current diff, and Start.
export function renderOverview(): void {
	const state = deskCtx().requireState()
	// '' counts as absent: fall back to a plain heading when the desk has no target ref.
	const title = state.target?.trim() ? state.target : 'Review'
	$('diff').innerHTML = `<div class="guide-overview"><div class="go-card">
    <h1>${esc(title)}</h1>
    <div class="go-sub">${esc(state.mode)} · ${esc(state.session)} · ${state.files.length} files</div>
    ${guideStale(GI()) ? `<div class="go-stale"><svg class="ic"><use href="#gly-warn"></use></svg> This grouping was made for an earlier version of the diff - regenerate it and reload with <code>--guide</code> to refresh the sections.</div>` : ''}
    <div class="go-actions"><button class="btn primary" id="guideStart">Start Review <kbd>↵</kbd></button></div>
  </div></div>`
	const start = $('diff').querySelector<HTMLButtonElement>('#guideStart')
	// The landing markup is rebuilt on every render, so this cannot stack listeners.
	start?.addEventListener('click', () => deskCtx().S.startGuided?.())
}
