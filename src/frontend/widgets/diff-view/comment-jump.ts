import { isFileComment, toDisplayLine } from '@entities/review/changes'
import { revealLine } from '@features/expand-context/expand'
import { $ } from '@shared/lib/dom'

import { cursorJumpTo } from './cursor'
import { D } from './runtime'

import type { ReviewFile } from '@entities/review/model'
import type { Side } from '@shared/diff-renderer/types'

// ── Jumping to a comment thread ─────────────────────────────────────────────
// One executor for every "go to this thread" affordance: the blockers chip's jump
// list, the notes panel, future ones. The thread renders in one of three places -
// the file-comment section under the header (whole-file thread), the unanchored
// strip above the diff (anchor lost), or as an annotation on a rendered row - and
// the jump must land on whichever one actually holds it right now.

export type JumpTarget = {
	path: string
	side: Side
	lineNumber: number
	// Whole-file thread: scrolls the file-comment section instead of a rendered line.
	fileLevel: boolean
	// Thread renders in the unanchored strip, not on a row.
	unanchored: boolean
}

function flash(el: HTMLElement): void {
	el.classList.remove('flash')
	void el.offsetWidth // restart the animation
	el.classList.add('flash')
}

function scrollAndFlash(selector: string, fallbackSelector?: string): void {
	const el = $('diff').querySelector<HTMLElement>(selector)
	const target =
		el ??
		(fallbackSelector
			? $('diff').querySelector<HTMLElement>(fallbackSelector)
			: null)
	target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
	if (el) flash(el)
}

// Jump to a thread of the CURRENTLY rendered file. Silent no-op when `file` isn't
// the thread's file (cross-file callers select the file first - see the notes
// facade, which routes through a pending jump the render funnel consumes).
export function jumpToThread(file: ReviewFile | null, t: JumpTarget): void {
	if (!file || file.path !== t.path) return
	if (t.fileLevel) {
		scrollAndFlash('.fc-section [data-file-thread]')
		return
	}
	if (t.unanchored) {
		scrollAndFlash(
			`.unanchored-strip [data-thread="${t.side}:${t.lineNumber}"]`,
			'.unanchored-strip',
		)
		return
	}
	// Unfold first if the line sits in a collapsed run, then land the cursor on it.
	revealLine(t.side, t.lineNumber)
	cursorJumpTo(t.side, toDisplayLine(t.side, t.lineNumber, D.lineMap))
}

// A comment's jump target, resolved off the record itself: file-level and
// unanchored classification matches what the render put where (annotations.ts /
// strip.ts) for a thread whose group carries the stamped flag.
export function jumpTargetFor(comment: {
	path: string
	side: Side
	lineNumber: number
	unanchored?: boolean
}): JumpTarget {
	return {
		path: comment.path,
		side: comment.side,
		lineNumber: comment.lineNumber,
		fileLevel: isFileComment(comment),
		unanchored: comment.unanchored === true,
	}
}

// ── Cross-file jumps ────────────────────────────────────────────────────────
// Selecting another file funnels through S.selectFile, whose render is scheduled
// (deferRender) and can await a contents fetch - so a panel click can't scroll
// synchronously. The caller stashes the target here; the render funnel consumes it
// once the new file's diff (or replacement view) is on screen.
let pending: JumpTarget | null = null

export function setPendingJump(t: JumpTarget): void {
	pending = t
}

// Consumed by render() after the center painted. Cleared on read: exactly one jump
// per set, and a render for an unexpected file simply drops it (jumpToThread no-ops
// on a path mismatch).
export function consumePendingJump(file: ReviewFile | null): void {
	const t = pending
	if (!t) return
	pending = null
	jumpToThread(file, t)
}
