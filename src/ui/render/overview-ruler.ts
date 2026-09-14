import { diffShadowRoot } from '../diff-dom'
import { $ } from '../store'

// VSCode-style change overview: map every change row's position in the scrolled content to a
// tick in a fixed right-edge ruler, so changes are visible in one skim of the whole file.
// Only meaningful in "expand unchanged" mode (otherwise the diff is already compact).

// A tick shorter than this fraction of the scrolled content stays visible: a one-line change is
// still a mark.
const MIN_MARK_HEIGHT_PERCENT = 0.3
const FULL_PERCENT = 100
// Sub-pixel slack when deciding whether the file scrolls at all.
const SCROLL_TOLERANCE_PX = 1

type RulerSide = 'add' | 'del'
// A change row's vertical span in the scrolled content, and the coalesced bar it belongs to.
type RulerMark = { side: RulerSide; top: number; bottom: number }

export function clearOverviewRuler(): void {
	const ruler = $('ovr')
	ruler.classList.remove('show')
	ruler.replaceChildren()
}

// The change rows of the mounted diff, if any. @pierre tags both the gutter cell and the code
// cell of a line with data-line-type, so each line matches twice - the spans below dedupe.
function measureSpans(): RulerMark[] {
	const shadow = diffShadowRoot()
	if (!shadow) return []
	const diff = $('diff')
	const diffTop = diff.getBoundingClientRect().top
	const { scrollTop } = diff
	const spans = new Map<string, RulerMark>()
	for (const row of shadow.querySelectorAll<HTMLElement>(
		"[data-line-type^='change-']",
	)) {
		const side: RulerSide = (
			row.getAttribute('data-line-type') ?? ''
		).includes('addition')
			? 'add'
			: 'del'
		const box = row.getBoundingClientRect()
		if (!box.height) continue
		// Content-relative top: the row's viewport offset plus how far the pane is scrolled.
		const top = box.top - diffTop + scrollTop
		spans.set(`${side}:${Math.round(top)}`, {
			side,
			top,
			bottom: top + box.height,
		})
	}
	// Document order is visual order for rows in the diff grid, so the map's insertion order is
	// already top-to-bottom - no sort needed.
	return [...spans.values()]
}

// Coalesce contiguous rows of the same side into one bar (a 5-line block becomes one tick).
function coalesceMarks(spans: RulerMark[]): RulerMark[] {
	const marks: RulerMark[] = []
	for (const span of spans) {
		const last = marks.at(-1)
		if (
			last &&
			last.side === span.side &&
			span.top - last.bottom <= span.bottom - span.top
		)
			last.bottom = span.bottom
		else marks.push({ ...span })
	}
	return marks
}

function paintRuler(marks: RulerMark[], contentHeight: number): void {
	const ruler = $('ovr')
	for (const mark of marks) {
		const tick = document.createElement('i')
		tick.className = mark.side
		tick.style.top = `${(mark.top / contentHeight) * FULL_PERCENT}%`
		const heightPercent =
			((mark.bottom - mark.top) / contentHeight) * FULL_PERCENT
		tick.style.height = `${Math.max(heightPercent, MIN_MARK_HEIGHT_PERCENT)}%`
		ruler.appendChild(tick)
	}
	ruler.classList.add('show')
}

export function renderOverviewRuler(): void {
	clearOverviewRuler()
	const diff = $('diff')
	// The scrolled content's height is the ruler's coordinate space; it cannot change between here
	// and paint (the ruler is fixed-position, outside the scroll container).
	const contentHeight = diff.scrollHeight
	// Only a map for a scrollable file - if it fits without scrolling, the changes are already all
	// on screen and the ruler is redundant noise.
	if (contentHeight <= diff.clientHeight + SCROLL_TOLERANCE_PX) return
	const marks = coalesceMarks(measureSpans())
	if (!marks.length) return
	paintRuler(marks, contentHeight)
}
