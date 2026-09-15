import { fromDisplayLine, toDisplayLine } from '../changes'
import { diffShadowRoot } from '../diff-dom'
import { $ } from '../store'

import { activeViewport } from './viewport'

import type { Side } from '../types'

type ScrollAnchor = { side: Side; rawLine: number; offset: number }

// Replaying a decision recreates the window and discards its measured wrap heights. Preserve
// a raw-file line, not a pixel scrollTop that now points into a different estimated layout.
export function captureScrollAnchor(): ScrollAnchor | undefined {
	if (!activeViewport() || !$('diff').scrollTop) return undefined
	const paneTop = $('diff').getBoundingClientRect().top
	for (const row of diffShadowRoot()?.querySelectorAll<HTMLElement>(
		'[data-line]',
	) ?? []) {
		const box = row.getBoundingClientRect()
		if (!box.height || box.top < paneTop) continue
		const side: Side =
			row.closest('[data-deletions]') ||
			row.dataset.lineType === 'change-deletion'
				? 'deletions'
				: 'additions'
		return {
			side,
			rawLine: fromDisplayLine(side, Number(row.dataset.line)),
			offset: box.top - paneTop,
		}
	}
	return undefined
}

export function restoreScrollAnchor(anchor: ScrollAnchor): void {
	activeViewport()?.reveal(
		anchor.side,
		toDisplayLine(anchor.side, anchor.rawLine),
		'start',
		anchor.offset,
	)
}
