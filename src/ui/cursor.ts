import { currentChanges, fromDisplayLine } from './changes'
import { mergeRows } from './cursor-rows'
import { acceptChange } from './decisions'
import { diffShadowRoot } from './diff-dom'
import { render } from './render'
import { activeViewport } from './render/viewport'
import { openCommentComposer } from './selection'
import { S, D, $, toast, persist } from './store'

import type { Row } from './cursor-rows'
import type { ChangeState, ReviewComment, Side } from './types'

// ── The diff line cursor ─────────────────────────────────────────────────────
// Keyboard review needs a "current line" the diff doesn't otherwise have. We keep it as a
// logical {side, line} (stable across re-renders, since line numbers are) and resolve it to a
// rendered row on demand. The highlight is @pierre's own line selection (setSelectedLines with
// notify:false - paints without firing the selection callbacks, so no composer popup), so
// pointer and keyboard share ONE highlight: a click seeds the cursor (cursorSyncTo) and the
// arrows move the same selection from there.

const GOLINE_COMMIT_MS = 800

let cur: { side: Side; line: number } | null = null

// rows() runs a full-file getBoundingClientRect sweep to build its Row[]; it's called per keypress
// (cursorMoveLine/Hunk, landAt, ensureCursor) and after every render (cursorResync), so on a large
// expanded file each arrow press forced a synchronous whole-file layout. The list is derived purely
// from DOM structure and content-relative tops (the stored `top` is relative to the scrolled
// content, not the viewport), so it's stable across scroll - only a re-render, or a resize
// reflowing line heights, actually changes it. So we cache it and rebuild only on those events:
// invalidateCursorRows() is wired to @pierre's onPostRender (render.ts - mount / update / unmount,
// which covers our render() AND @pierre's own expandHunk rerenders) and to window resize (main.ts).
// Scroll deliberately does NOT invalidate: scrolling never changes the list, and arrow navigation
// (which scrolls via scrollIntoView) stays on cache hits instead of re-sweeping the file per press.
let cached: Row[] | null = null

export function invalidateCursorRows(): void {
	cached = null
}

// The side a gutter cell belongs to: its line type first, else which split column holds it.
function lineSide(type: string, column: Element | null): Side {
	if (type.includes('deletion')) return 'deletions'
	if (type.includes('addition')) return 'additions'
	if (column?.hasAttribute('data-deletions')) return 'deletions'
	return 'additions'
}

// Every navigable code line in visual (top-to-bottom) order. @pierre tags each line's gutter with
// a [data-line-number-content] span inside a [data-line-type] cell, within a [data-additions] /
// [data-deletions] column (split) - that gives us side + number + row element. Context lines show
// in both split columns at the same y; mergeRows() folds those twins into one row.
function rows(): Row[] {
	const viewport = activeViewport()
	if (viewport) return viewport.rows()
	if (cached) return cached
	const shadow = diffShadowRoot()
	if (!shadow) return [] // shadow not mounted yet - don't cache, retry on the next call
	const diff = $('diff')
	const diffTop = diff.getBoundingClientRect().top
	const { scrollTop } = diff
	const out: Row[] = []
	shadow
		.querySelectorAll<HTMLElement>('[data-line-number-content]')
		.forEach(span => {
			const cell = span.closest<HTMLElement>('[data-line-type]')
			if (!cell) return
			const type = cell.getAttribute('data-line-type') ?? ''
			const column = span.closest<HTMLElement>(
				'[data-additions],[data-deletions]',
			)
			const line = parseInt(span.textContent, 10)
			if (!Number.isFinite(line)) return
			const rect = cell.getBoundingClientRect()
			if (!rect.height) return
			out.push({
				el: cell,
				side: lineSide(type, column),
				line,
				top: rect.top - diffTop + scrollTop,
				height: rect.height,
				change: type.startsWith('change-'),
			})
		})
	cached = mergeRows(out)
	return cached
}

// A row matches on its primary coordinates or its split-view twin (`alt`).
function matches(row: Row, side: Side, line: number): boolean {
	if (row.side === side && row.line === line) return true
	return !!row.alt && row.alt.side === side && row.alt.line === line
}

function indexOfCur(list: Row[]): number {
	const cursor = cur
	return cursor
		? list.findIndex(r => matches(r, cursor.side, cursor.line))
		: -1
}

// Paint the cursor as @pierre's native line selection. notify:false keeps the selection
// callbacks (which open the comment composer) from firing on keyboard movement.
function paint(r: Row): void {
	D.instance?.setSelectedLines(
		{ start: r.line, end: r.line, side: r.side },
		{ notify: false },
	)
}

function hide(): void {
	D.instance?.setSelectedLines(null, { notify: false })
}

function landOn(r: Row | undefined, shouldScroll = true): void {
	if (!r) return
	cur = { side: r.side, line: r.line }
	paint(r)
	if (!shouldScroll) return
	if (activeViewport()?.reveal(r.side, r.line, 'nearest')) return
	r.el?.scrollIntoView({ block: 'nearest' })
}

// Adopt a pointer-made selection as the cursor position, so the arrows continue from the
// clicked line instead of restarting at the first change. @pierre already painted the
// selection itself - no repaint, no scroll.
export function cursorSyncTo(side: Side, line: number): void {
	cur = { side, line }
}

// Re-resolve the cursor after a render: keep the same logical line, just repaint. The cursor
// is hidden until the reviewer navigates or clicks (no auto-highlighted first line), so when
// there's no active cursor we clear the selection instead.
export function cursorResync(): void {
	const cursor = cur
	if (!cursor) {
		hide()
		return
	}
	const r = rows().find(x => matches(x, cursor.side, cursor.line))
	if (r) paint(r)
	else hide()
}

// Drop the cursor (file switch, overview, markdown view) - clears the highlight entirely.
export function cursorReset(): void {
	cur = null
	hide()
}

export function cursorSelection(): { side: Side; lineNumber: number } | null {
	if (!cur) return null
	return { side: cur.side, lineNumber: cur.line }
}

// Reveal the cursor on first use: land on the first change (else the first line). Returns the row.
function ensureCursor(): Row | undefined {
	const cursor = cur
	if (cursor) return rows().find(x => matches(x, cursor.side, cursor.line))
	const list = rows()
	if (!list.length) return undefined
	const r = list.find(x => x.change) ?? list[0]
	landOn(r, false)
	return r
}

// Land the cursor on a specific rendered line (display space) and center it. Context rows merge
// to a single entry (additions primary, deletions twin in `alt`), so fall back to a line-only
// match before giving up.
function landAt(side: Side, line: number): boolean {
	const list = rows()
	const r =
		list.find(x => matches(x, side, line)) ??
		list.find(x => x.line === line)
	if (!r) return false
	cur = { side: r.side, line: r.line }
	paint(r)
	if (!activeViewport()?.reveal(r.side, r.line, 'center'))
		r.el?.scrollIntoView({ block: 'center' })
	return true
}

// Jump used by the blockers list. Retries once across two frames so a just-triggered
// collapsed-region expansion (which rerenders) has laid out its rows.
export function cursorJumpTo(side: Side, line: number): void {
	if (!landAt(side, line))
		requestAnimationFrame(() =>
			requestAnimationFrame(() => landAt(side, line)),
		)
}

// ── Go to line ───────────────────────────────────────────────────────────────
// Typing digits in the diff accumulates a line number (shown as the goline pill); ↵ or a short
// idle pause commits the jump, Esc cancels. Commit only moves the cursor - the existing ↵ /
// ⇧Y / r bindings take over from the landed line, so the jump composes with every verb.

let golineTimer: ReturnType<typeof setTimeout> | undefined

export function golineActive(): boolean {
	return !!S.golineBuffer
}

export function golineDigit(d: string): void {
	if (!S.golineBuffer && d === '0') return // a leading 0 can't start a real line number
	S.golineBuffer += d
	clearTimeout(golineTimer)
	golineTimer = setTimeout(golineCommit, GOLINE_COMMIT_MS)
}

export function golineCancel(): void {
	S.golineBuffer = ''
	clearTimeout(golineTimer)
}

export function golineCommit(): void {
	const n = parseInt(S.golineBuffer, 10)
	golineCancel()
	if (!Number.isFinite(n)) return
	// Prefer the additions/new side - the number a reviewer reads off the gutter. No retry:
	// goline never triggers an expansion, so a miss means the line isn't rendered.
	if (!landAt('additions', n)) toast(`Line ${n} isn't visible in this diff`)
}

export function cursorMoveLine(dir: 1 | -1): void {
	const list = rows()
	if (!list.length) return
	if (!cur) {
		ensureCursor()
		return
	} // first press just reveals the cursor
	const i = indexOfCur(list)
	if (i < 0) {
		landOn(dir === 1 ? list[0] : list[list.length - 1])
		return
	}
	landOn(list[Math.max(0, Math.min(list.length - 1, i + dir))])
}

// Jump to the first line of the next/previous change run (a contiguous block of change rows).
export function cursorMoveHunk(dir: 1 | -1): void {
	const list = rows()
	if (!list.length) return
	if (!cur) {
		ensureCursor()
		return
	} // first press just reveals the cursor (on the first change)
	const isStart = (j: number): boolean =>
		list[j].change && (j === 0 || !list[j - 1].change)
	const i = indexOfCur(list)
	for (let j = i + dir; j >= 0 && j < list.length; j += dir) {
		if (isStart(j)) {
			landOn(list[j])
			return
		}
	}
	toast(dir === 1 ? 'No more changes' : 'No previous changes')
}

// The change (hunk) whose range covers the cursor line on its side. The cursor reads
// rendered gutter numbers (display space), so compare against the display anchors.
function cursorChange(): ChangeState | null {
	const cursor = cur
	if (!cursor) return null
	return (
		currentChanges().find(
			c =>
				c.side === cursor.side &&
				cursor.line >= (c.displayLineNumber ?? c.lineNumber) &&
				cursor.line <= (c.displayEndLine ?? c.endLine ?? c.lineNumber),
		) ?? null
	)
}

// Open the comment composer anchored to the cursor line (keyboard equivalent of clicking a
// line). The composer renders inline at S.selected, so there's nothing to position.
export function cursorComment(): void {
	if (!cur) ensureCursor()
	if (!cur) return
	S.selected = { side: cur.side, lineNumber: cur.line }
	openCommentComposer()
}

// Accept (Keep) / reject (Undo) the change under the cursor.
export function cursorVerdict(status: 'accepted' | 'rejected'): void {
	if (!cur) ensureCursor()
	const change = cursorChange()
	if (!change) {
		toast('No change under the cursor')
		return
	}
	void acceptChange(change.id, status)
}

function threadComments(): ReviewComment[] {
	const cursor = cur
	if (!cursor) return []
	const raw = fromDisplayLine(cursor.side, cursor.line) // comments persist raw lines
	return (S.state?.comments ?? []).filter(
		c =>
			c.path === (S.preview?.path ?? S.state?.files[S.fileIndex]?.path) &&
			c.side === cursor.side &&
			c.lineNumber === raw,
	)
}

// Toggle resolve/reopen on the cursor line's thread.
export function cursorResolve(): void {
	const thread = threadComments()
	if (!thread.length) {
		toast('No comment on this line')
		return
	}
	const isOpen = thread.some(c => c.status === 'open')
	for (const c of thread) c.status = isOpen ? 'resolved' : 'open'
	void render()
	persist()
	toast(isOpen ? 'Resolved' : 'Reopened')
}
