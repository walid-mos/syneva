import { currentSplittable } from '../changes'
import { currentGuideEntry } from '../guide'
import { S } from '../store'

import type { ReviewState } from '../types'

type ReviewFile = ReviewState['files'][number]
export type DiffView = { isPreviewing: boolean; isExpandedUnchanged: boolean }

// Identity of a rendered diff for the LRU cache: the current file + every option that changes
// what @pierre renders. deferRender uses this to tell if re-opening a file will be a fast cache
// hit (-> skip the "Rendering…" indicator). Reads currentSplittable(), so call after fileIndex is set.
export function diffKey(file: ReviewFile, view: DiffView): string {
	return JSON.stringify([
		file.path,
		file.contentHash,
		S.state?.baseDiffHash,
		view.isPreviewing,
		currentSplittable() ? S.diffStyle : 'unified',
		view.isExpandedUnchanged,
		S.settings.unchangedLines,
		// The hide-reviewed pref drops accepted bands from the rendered structure.
		S.settings.hideReviewed,
		view.isPreviewing ? 'none' : S.settings.diffIndicators,
		S.settings.overflow,
		S.settings.hunkSeparators,
		S.settings.lineDiffType,
		S.settings.theme,
		// appearance flips @pierre's themeType, so a cached diff must invalidate on it
		S.settings.appearance,
		S.settings.font,
		S.settings.fontSize,
		S.settings.tabSize,
		currentGuideEntry(),
	])
}
