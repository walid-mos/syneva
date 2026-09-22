import { currentSplittable } from '@entities/review/file/contents'
import { currentGuideEntry } from '@entities/review/guide/guide'

import { diffCtx } from './context'

import type { GuideInputs } from '@entities/review/guide/guide'
import type { ReviewState } from '@entities/review/model'

// The guide derivations' explicit inputs, read from the store at each evaluation.
const GI = (): GuideInputs => ({
	state: diffCtx().S.state,
	fileIndex: diffCtx().S.fileIndex,
	hideReviewed: diffCtx().S.settings.hideReviewed,
	progressBy: diffCtx().S.settings.progressBy,
	foldExpanded: diffCtx().S.foldExpanded,
})

type ReviewFile = ReviewState['files'][number]
export type DiffView = { isPreviewing: boolean; isExpandedUnchanged: boolean }

// Identity of a rendered diff for the LRU cache: the current file + every option that changes
// what @pierre renders. deferRender uses this to tell if re-opening a file will be a fast cache
// hit (-> skip the "Rendering…" indicator). Reads currentSplittable(diffCtx().S.preview ?? diffCtx().S.state?.files[diffCtx().S.fileIndex]), so call after fileIndex is set.
export function diffKey(file: ReviewFile, view: DiffView): string {
	return JSON.stringify([
		file.path,
		file.contentHash,
		diffCtx().S.state?.baseDiffHash,
		view.isPreviewing,
		currentSplittable(
			diffCtx().S.preview ??
				diffCtx().S.state?.files[diffCtx().S.fileIndex],
		)
			? diffCtx().S.diffStyle
			: 'unified',
		view.isExpandedUnchanged,
		diffCtx().S.settings.unchangedLines,
		// The hide-reviewed pref drops accepted bands from the rendered structure.
		diffCtx().S.settings.hideReviewed,
		view.isPreviewing ? 'none' : diffCtx().S.settings.diffIndicators,
		diffCtx().S.settings.overflow,
		diffCtx().S.settings.hunkSeparators,
		diffCtx().S.settings.lineDiffType,
		diffCtx().S.settings.theme,
		// appearance flips @pierre's themeType, so a cached diff must invalidate on it
		diffCtx().S.settings.appearance,
		diffCtx().S.settings.font,
		diffCtx().S.settings.fontSize,
		diffCtx().S.settings.tabSize,
		currentGuideEntry(GI()),
	])
}
