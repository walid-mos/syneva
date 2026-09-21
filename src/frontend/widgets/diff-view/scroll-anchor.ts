import { fromDisplayLine, toDisplayLine } from '@entities/review/changes'
import { activeViewport } from '@shared/diff-renderer/viewport'
import { diffShadowRoot } from '@shared/lib/diff-dom'
import { $ } from '@shared/lib/dom'

import { D } from './runtime'

import type { Side } from '@shared/diff-renderer/types'

type ScrollAnchor = { side: Side; rawLine: number; offset: number }

// Replaying a decision recreates the window and discards its measured wrap heights. Preserve
// a raw-file line, not a pixel scrollTop that now points into a different estimated layout.
export function captureScrollAnchor(): ScrollAnchor | undefined {
	if (!activeViewport(D.instance) || !$('diff').scrollTop) return undefined
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
			rawLine: fromDisplayLine(side, Number(row.dataset.line), D.lineMap),
			offset: box.top - paneTop,
		}
	}
	return undefined
}

export function restoreScrollAnchor(anchor: ScrollAnchor): void {
	activeViewport(D.instance)?.reveal(
		anchor.side,
		toDisplayLine(anchor.side, anchor.rawLine, D.lineMap),
		'start',
		anchor.offset,
	)
}
