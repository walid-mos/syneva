import { flowIndex } from './changes'
import { reviewLineCount } from './file-summary'
import { guideProgress } from './guide'
import { S, $ } from './store'

// Persistent review-progress chrome: a full-width fill strip along the bottom edge of the
// topbar plus a "% reviewed" label beside the actions, visible with or without a guide (the
// guidebar used to be progress's only home, so guideless desks showed none). Imperative
// rather than Alpine because the *moment* of progress is animated - the number counts up
// odometer-style and the strip pulses when the bar advances - which is rAF work.
const COUNT_UP_MS = 450
const EASE_POWER = 3
const FULL_PERCENT = 100

// Tab title carries progress too ("(58%) Galley - repo"), so it reads from other tabs.
// main.ts names the base title at init; updateProgress stamps the prefix.
let baseTitle = document.title
export function setBaseTitle(title: string): void {
	baseTitle = title
}

let shownPct: number | null = null // % the label currently shows; null until first paint
let raf = 0

function titleFor(pct: number): string {
	if (pct >= FULL_PERCENT) return `✓ ${baseTitle}`
	if (pct > 0) return `(${pct}%) ${baseTitle}`
	return baseTitle
}

// Count the label from `from` to `to` over ~450ms (ease-out) instead of jumping. `show` receives
// each intermediate percentage; the caller owns the element.
function countUp(from: number, to: number, show: (pct: number) => void): void {
	cancelAnimationFrame(raf)
	const start = performance.now()
	const tick = (now: number): void => {
		const k = Math.min(1, (now - start) / COUNT_UP_MS)
		const eased = 1 - (1 - k) ** EASE_POWER
		show(Math.round(from + (to - from) * eased))
		if (k < 1) raf = requestAnimationFrame(tick)
	}
	raf = requestAnimationFrame(tick)
}

// Restart the .pulse CSS animation even when the class is already on the element.
function pulse(el: HTMLElement): void {
	el.classList.remove('pulse')
	void el.offsetWidth
	el.classList.add('pulse')
}

// Called from render(): every state mutation that can move progress ends in a render, so
// this is the single repaint point (and it must stay cheap - guideProgress is one pass).
export function updateProgress(): void {
	const strip = $('progressStrip')
	const label = $('progressPct')
	const hasFiles = !!S.state?.files.length
	strip.style.display = hasFiles ? '' : 'none'
	label.style.display = hasFiles ? '' : 'none'
	if (!hasFiles) {
		document.title = baseTitle
		return
	}
	const { pct } = guideProgress()
	document.title = titleFor(pct)
	$('progressFill').style.width = `${pct}%` // CSS transition animates the fill
	if (shownPct === null || pct === shownPct) {
		// First paint, or no movement (a re-render that didn't change progress): no ceremony.
		label.textContent = `${pct}% reviewed`
		shownPct = pct
		return
	}
	if (pct > shownPct) pulse(strip)
	countUp(shownPct, pct, percent => {
		label.textContent = `${percent}% reviewed`
	})
	shownPct = pct
}

// Whole-review numbers for the completion prompt - a small receipt of the work done.
export function reviewStats(): {
	files: number
	lines: number
	comments: number
	rejections: number
} {
	// Files out of the flow - fully skimmed or pure renames (issue 01/07) - stay out of the
	// completion receipt's file and line totals so the numbers match the progress bar and the gate.
	// One flow-index pass instead of a per-file rescan (see flow-index.ts).
	const { outOfFlow } = flowIndex()
	const scope = (S.state?.files ?? []).filter(f => !outOfFlow.has(f.path))
	let lines = 0
	for (const f of scope) lines += reviewLineCount(f)
	return {
		files: scope.length,
		lines,
		comments: (S.state?.comments ?? []).filter(
			c => c.role === 'user' && c.status === 'open',
		).length,
		rejections: (S.state?.changes ?? []).filter(
			c => c.status === 'rejected',
		).length,
	}
}
