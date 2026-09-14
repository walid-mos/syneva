import { closeComposer, openComposer } from './composer'
import { cursorSyncTo } from './cursor'
import { sideFromLineType } from './selection-derive'
import { S, $ } from './store'

import type { FileDiffOptions } from '@pierre/diffs'
import type { AnnotationMeta, Side } from './types'

// @pierre/diffs' line callbacks pass slightly different payloads per entry point: a line click
// carries the row's `lineNumber` and `annotationSide`, a selection carries a range whose endpoints
// are `start`/`end`, and older releases have named the line number `number`, `line.number` or
// `lineInfo.number`. The reader below therefore accepts every candidate as `unknown` and narrows
// each one at runtime: a library bump that renames a field degrades to the next candidate instead
// of silently dropping the click.
type LineCallbackPayload = {
	lineNumber?: unknown
	number?: unknown
	line?: { number?: unknown; side?: unknown }
	lineInfo?: { number?: unknown; side?: unknown }
	annotationSide?: unknown
	side?: unknown
	type?: unknown
	start?: unknown
	end?: unknown
}

// The library's own callback signatures, read off the options type so the handlers below stay in
// step with the pinned release instead of restating its payloads.
type DiffCallbacks = FileDiffOptions<AnnotationMeta>
type LineClickPayload = Parameters<
	NonNullable<DiffCallbacks['onLineNumberClick']>
>[0]
type SelectionRange = Parameters<
	NonNullable<DiffCallbacks['onLineSelected']>
>[0]

// A line the composer and the keyboard cursor both understand: which line, on which side, and (for
// a drag) the far end of the range.
type LineTarget = { lineNumber: number; side: Side; endLine?: number }

// Split (side-by-side) view geometry: the pointer is in the left half of the diff pane.
const PANE_MIDPOINT_FRACTION = 0.5
// How long a click that closed the composer stays swallowed, so @pierre's own selection callback
// for that same click can't reopen it.
const CLICK_SUPPRESSION_MS = 350
const LINE_NUMBER_TEXT = /^\d+$/

let dragSelectionStart: LineTarget | null = null
let suppressSelectionUntil = 0
let isIgnoringNextLineClick = false

function readLineNumber(payload: LineCallbackPayload): number | null {
	const candidates = [
		payload.lineNumber,
		payload.number,
		payload.line?.number,
		payload.lineInfo?.number,
	]
	for (const candidate of candidates) {
		if (typeof candidate === 'number' && Number.isFinite(candidate)) {
			return candidate
		}
	}
	return null
}

function readSide(payload: LineCallbackPayload): Side {
	const named =
		payload.annotationSide ??
		payload.side ??
		payload.line?.side ??
		payload.lineInfo?.side ??
		payload.type
	return normalizeSide(named)
}

// The line a callback payload names, or null when it names none (a selection range's bare
// endpoint, a context row, an unknown shape).
function extractLinePayload(
	payload: LineCallbackPayload | number | null | undefined,
): LineTarget | null {
	if (typeof payload !== 'object' || payload === null) return null
	const lineNumber = readLineNumber(payload)
	if (lineNumber === null) return null
	return { lineNumber, side: readSide(payload) }
}

// A selection callback hands a range, whose `end`/`start` are plain numbers rather than a line the
// composer can anchor to - so a range yields no line target today, and drags stay owned by the
// pointer handlers below. Unwrapping the endpoint keeps a payload that does name a line working.
function selectionEndpoint(
	range: SelectionRange | null,
): LineCallbackPayload | number | null {
	if (!range) return null
	return range.end || range.start || range
}

// What the pointer is over, read off the DOM rather than a payload: @pierre renumbers lines per
// render, so the visible gutter text is what the reviewer actually clicked.
function readPointerText(target: Element): string {
	const innerText = target instanceof HTMLElement ? target.innerText : ''
	return (innerText || target.textContent || '').trim()
}

function linePayloadFromPointerEvent(event: PointerEvent): LineTarget | null {
	for (const target of event.composedPath()) {
		if (!(target instanceof Element)) continue
		const text = readPointerText(target)
		if (!LINE_NUMBER_TEXT.test(text)) continue
		// Prefer the row's own side (@pierre's data-line-type on this cell or an ancestor): in
		// Stacked (unified) view one column carries both sides, so a drag ending on a deletion's
		// right half is mis-tagged by horizontal geometry. Fall back to geometry only when no row
		// type is found (Split view, where the geometric split is correct).
		const lineType =
			target
				.closest('[data-line-type]')
				?.getAttribute('data-line-type') ?? null
		const box = $('diff').getBoundingClientRect()
		return {
			lineNumber: Number(text),
			side:
				sideFromLineType(lineType) ??
				(event.clientX < box.left + box.width * PANE_MIDPOINT_FRACTION
					? 'deletions'
					: 'additions'),
		}
	}
	return null
}

// A line click/drag opens an inline composer anchored under the selected line (option B -
// no intermediate action pop). The composer is a `composer` annotation the diff render
// injects at S.selected, so there's nothing to position at the pointer.
export function openCommentComposer(): void {
	openComposer()
}

export function normalizeSide(side: unknown): Side {
	return side === 'deletions' || side === 'old' ? 'deletions' : 'additions'
}

function showForDiffLine(payload: LineTarget): void {
	S.selected = {
		side: payload.side,
		lineNumber: payload.lineNumber,
		endLine: payload.endLine,
	}
	// The pointer selection becomes the keyboard cursor too (one highlight, one position),
	// so the arrows continue from the clicked line - the end of the range for a drag.
	cursorSyncTo(payload.side, payload.endLine ?? payload.lineNumber)
	openCommentComposer()
}

export function composerHasText(): boolean {
	return S.composerOpen && S.composerBody.trim().length > 0
}

export function closeComposerIfEmpty(isRenderDeferred = false): void {
	if (S.composerOpen && !composerHasText()) closeComposer(isRenderDeferred)
}

export function handleDiffSelection(range: SelectionRange | null): void {
	if (Date.now() < suppressSelectionUntil) return
	const payload = range ? extractLinePayload(selectionEndpoint(range)) : null
	if (payload) {
		showForDiffLine(payload)
		return
	}
	if (range) return
	closeComposerIfEmpty()
	isIgnoringNextLineClick = true
	setTimeout(() => (isIgnoringNextLineClick = false), 0)
}

export function handleLineNumberClick(props: LineClickPayload): void {
	if (isIgnoringNextLineClick) {
		isIgnoringNextLineClick = false
		return
	}
	const payload = extractLinePayload(props)
	if (!payload) return
	// Re-clicking the composer's own line closes it (when empty) instead of reopening.
	if (
		S.composerOpen &&
		S.selected.lineNumber === payload.lineNumber &&
		S.selected.side === payload.side
	) {
		if (!composerHasText()) closeComposer()
		suppressSelectionUntil = Date.now() + CLICK_SUPPRESSION_MS
		return
	}
	showForDiffLine(payload)
}

function handleSelectionPointerDown(event: PointerEvent): void {
	dragSelectionStart = linePayloadFromPointerEvent(event)
}

function handleSelectionPointerUp(event: PointerEvent): void {
	const end = linePayloadFromPointerEvent(event)
	if (!dragSelectionStart || !end) return
	const isSameLine =
		dragSelectionStart.lineNumber === end.lineNumber &&
		dragSelectionStart.side === end.side
	if (isSameLine) return
	showForDiffLine({ ...dragSelectionStart, endLine: end.lineNumber })
	dragSelectionStart = null
}

export function attachDiffSelectionHandlers(): void {
	const root = $('diff')
	// This runs after every render, and #diff outlives them all - detach first, so repeated calls
	// replace the handler (what assigning to `onpointerdown` used to do) instead of stacking one
	// more listener per render.
	root.removeEventListener('pointerdown', handleSelectionPointerDown)
	root.addEventListener('pointerdown', handleSelectionPointerDown)
	root.removeEventListener('pointerup', handleSelectionPointerUp)
	root.addEventListener('pointerup', handleSelectionPointerUp)
}
