import {
	anyUnreviewed,
	currentFileName,
	currentGuideEntry,
	firstGuideIndex,
	guideStale,
	hasGuide,
	nextFileIndex,
	nextWrapIndex,
	prevFileIndex,
	prevWrapIndex,
	showGuideBar,
	walkthroughRows,
} from '../guide'
import { render } from '../render'
import { S } from '../store'

// The guide-bar bindings: what the top bar shows (category, filename, staleness), and the guided
// walk (Overview -> first file -> per-file stepping -> wrap). The seeks themselves are guide.ts's
// store-reading wrappers over seek.ts's pure order logic.
export function installGuideBindings(): void {
	S.walkthroughRows = walkthroughRows
	S.hasGuide = hasGuide
	S.showGuideBar = showGuideBar
	S.guideStale = guideStale
	S.curGuide = currentGuideEntry
	S.curFileName = currentFileName
	// Guided review: ⌂ returns to the Overview page; Start enters the per-file flow at the first
	// file in the guide's order.
	S.openOverview = () => {
		S.overviewOpen = true
		void render()
	}
	S.startGuided = () => {
		S.overviewOpen = false
		S.selectFile?.(firstGuideIndex())
	}
	// Guided navigation: the Overview is the position before the first file. From it, Next enters
	// the first file and Prev is a no-op; within files, Prev off the first drops to the Overview.
	S.guideNext = () => {
		if (S.overviewOpen) {
			S.startGuided?.()
			return
		}
		// Off the last file, wrap to the first unreviewed file (else cycle to the first) instead of
		// dead-ending, so skipped files are surfaced.
		const target = nextFileIndex(S.fileIndex) ?? nextWrapIndex()
		if (target !== null) S.selectFile?.(target)
	}
	S.guidePrev = () => {
		// Stepping back from the Overview (the position before the first file) wraps to the end - the
		// last unreviewed file, else the last file.
		if (S.overviewOpen) {
			const wrap = prevWrapIndex()
			if (wrap !== null) S.selectFile?.(wrap)
			return
		}
		// Off the first file, drop to the Overview (unchanged); the wrap happens from there.
		const p = prevFileIndex(S.fileIndex)
		if (p === null) S.openOverview?.()
		else S.selectFile?.(p)
	}
	// The nav buttons dim only when the review is fully signed off (nothing left to wrap to) - while
	// unreviewed work remains, next/prev stay live because they now seek it.
	S.guideAtStart = () => S.overviewOpen && !anyUnreviewed()
	S.guideAtLast = () =>
		!S.overviewOpen &&
		nextFileIndex(S.fileIndex) === null &&
		!anyUnreviewed()
}
