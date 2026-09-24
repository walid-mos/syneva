import { S } from '@app/store'
import {
	anyUnreviewed,
	currentFileName,
	currentGuideEntry,
	firstGuideIndex,
	guideStale,
	hasGuide,
	nextFileIndex,
	showGuideBar,
	walkthroughRows,
} from '@entities/review/guide/guide'
import { render } from '@shared/lib/render-scheduler'

import type { GuideInputs } from '@entities/review/guide/guide'

// The guide derivations' explicit inputs, read from the store at each evaluation.
const GI = (): GuideInputs => ({
	state: S.state,
	fileIndex: S.fileIndex,
	hideReviewed: S.settings.hideReviewed,
	progressBy: S.settings.progressBy,
	foldExpanded: S.foldExpanded,
})

// The guide-bar bindings: what the top bar shows (category, filename, staleness), and the guided
// walk (Overview -> first file -> per-file stepping -> wrap). The seeks themselves are guide.ts's
// store-reading wrappers over seek.ts's pure order logic.
export function installGuideBindings(): void {
	S.walkthroughRows = () => walkthroughRows(GI())
	S.hasGuide = () => hasGuide(GI())
	S.showGuideBar = () => showGuideBar(GI())
	S.guideStale = () => guideStale(GI())
	S.curGuide = () => currentGuideEntry(GI())
	S.curFileName = () => currentFileName(GI())
	// Guided review: ⌂ returns to the Overview page; Start enters the per-file flow at the first
	// file in the guide's order.
	S.openOverview = () => {
		S.overviewOpen = true
		void render()
	}
	S.startGuided = () => {
		S.overviewOpen = false
		S.selectFile?.(firstGuideIndex(GI()))
	}
	// Guided navigation is the one step (see navigate.ts): the ACTIVE pane's sorting decides
	// the order; the Overview is the position before the first file, so Next enters it and
	// Prev lands on the last one.
	S.guideNext = () => S.stepInView?.(1)
	S.guidePrev = () => S.stepInView?.(-1)
	// The nav buttons dim only when the review is fully signed off (nothing left to wrap to) - while
	// unreviewed work remains, next/prev stay live because they now seek it.
	S.guideAtStart = () => S.overviewOpen && !anyUnreviewed(GI())
	S.guideAtLast = () =>
		!S.overviewOpen &&
		nextFileIndex(GI(), S.fileIndex) === null &&
		!anyUnreviewed(GI())
}
