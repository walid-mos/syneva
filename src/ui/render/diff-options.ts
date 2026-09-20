import { renderAnnotation } from '../annotations'
import { currentSplittable } from '../changes'
import { restorePendingComposerFocus } from '../composer'
import { invalidateCursorRows } from '../cursor'
import { handleDiffSelection, handleLineNumberClick } from '../selection'
import { D, S } from '../store'

import { createDiffHeader, headerActions } from './file-header'
import { scheduleOverviewRuler } from './overview-ruler'
import { activeViewport } from './viewport'
import { VirtualDiff } from './virtual-diff'
import { noteRenderedViewport } from './worker-pool'

import type { FileDiffOptions } from '@pierre/diffs'
import type { AnnotationMeta } from '../types'
import type { DiffView } from './diff-key'

// Preview reads as a plain file: remap @pierre's addition styling to its CONTEXT (unchanged)
// styling - row tint, gutter cell bg, and gutter number color all to the neutral context values -
// so a one-sided render of an unchanged file isn't all-green. These must be set INSIDE @pierre's
// shadow (via unsafeCSS below): the context vars they reference only exist there, so a host-level
// override referencing them is invalid and silently reverts.
const PREVIEW_CSS =
	'[data-code]{--diffs-bg-addition-override:var(--diffs-bg-context);--diffs-bg-addition-emphasis-override:var(--diffs-bg-context);--diffs-bg-addition-number-override:var(--diffs-bg-context-gutter);--diffs-fg-number-addition-override:var(--diffs-fg-number)}'

// The @pierre render options for one instance. `renderHeaderMetadata` and `renderCustomHeader`
// are our own header builders (see file-header.ts).
export function diffOptions(
	view: DiffView,
): FileDiffOptions<AnnotationMeta, undefined> {
	const { isPreviewing, isExpandedUnchanged } = view
	return {
		// The code theme is the user's pick regardless of appearance (the settings dropdown groups
		// dark and light themes; mixing is allowed). Both slots get it - themeType only decides
		// which slot @pierre reads plus its own chrome colors, which follow the appearance.
		theme: { dark: S.settings.theme, light: S.settings.theme },
		themeType: S.settings.appearance === 'light' ? 'light' : 'dark',
		diffStyle: currentSplittable() ? S.diffStyle : 'unified',
		diffIndicators: isPreviewing ? 'none' : S.settings.diffIndicators,
		expandUnchanged: isExpandedUnchanged,
		overflow: S.settings.overflow,
		hunkSeparators: S.settings.hunkSeparators,
		lineDiffType: S.settings.lineDiffType,
		enableLineSelection: true,
		renderAnnotation,
		onLineNumberClick: handleLineNumberClick,
		onLineSelectionStart: handleDiffSelection,
		onLineSelectionChange: handleDiffSelection,
		onLineSelected: handleDiffSelection,
		onLineSelectionEnd: handleDiffSelection,
		renderHeaderMetadata: headerActions,
		// @pierre's own post-render signal - fires once the diff rows are committed to the shadow
		// DOM (mount and every update). (afterRender still runs the viewport work below.)
		// warm/cached path where rows are already present - both are idempotent.)
		onPostRender: (_node, instance, phase) => {
			if (instance !== D.instance) return
			// The rendered rows just changed (mount, update, or @pierre's own expandHunk rerender -
			// which never routes through our render()), so the cursor's cached row list is stale.
			invalidateCursorRows()
			if (phase === 'unmount') return
			// Calibrate the row-height estimate as soon as real rows are committed (mount, cached
			// remount): the library only runs its own reconcile on window changes, so an estimate left
			// 1× short in wrap mode would inflate the whole document coordinate space under the scroll
			// anchor on the reviewer's first scroll tick instead. One rAF out: the rows just committed;
			// a frame later their heights are laid out and scrollTop is still 0, so the correction is
			// invisible. Self-guarding - a no-op once calibrated.
			if (instance instanceof VirtualDiff) {
				const diff = instance
				// Rows committed: tell the pool which slice is on screen. A cache-hit range (the
				// renderCache holds the full grid) serves rows without a plain fetch, so the
				// stream would never learn the reviewer moved - and never tokenize what they see.
				noteRenderedViewport(diff)
				requestAnimationFrame(() => diff.calibrateLineHeight())
			}
			activeViewport()?.afterPaint()
			requestAnimationFrame(restorePendingComposerFocus)
			if (!isPreviewing && isExpandedUnchanged) scheduleOverviewRuler()
		},
		// @pierre reserves a right-side gutter via `scrollbar-gutter: stable` on the code grid (for
		// a vertical scrollbar it hides) - drop it so rows fill the full width. PREVIEW_CSS (empty
		// unless previewing) neutralizes addition styling to context, in-shadow.
		unsafeCSS: `[data-code]{scrollbar-gutter:auto}${isPreviewing ? PREVIEW_CSS : ''}`,
		renderCustomHeader: createDiffHeader(isPreviewing),
	}
}
