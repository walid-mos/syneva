import { currentComments, currentFileOrNull, toDisplayLine } from './changes'
import { S, D } from './store'
import { isUnanchored } from './unanchored'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { Side } from './types'

// ── Revealing lines hidden in collapsed unmodified regions ───────────────────
// In "collapse" mode, long unchanged runs fold into "N unmodified lines" separators  -
// and an annotation on a folded line simply never renders. A comment thread that ends
// up there after the agent's edits (its block became unchanged) would be invisible,
// and an open change request blocks approval. So after each render we auto-expand a
// small window around any open thread's line.
//
// @pierre's model: the collapsed region before hunk `i` is keyed `i` (the trailing
// region after the last hunk is keyed `hunks.length`); expandHunk(i, "up", n) reveals
// n lines from the region's TOP (just after the previous hunk), "down" from its BOTTOM
// (just before hunk i). Expansion state lives on the renderer instance, so it survives
// re-renders for as long as the instance is cached.

const REVEAL_CONTEXT = 3 // extra lines past the target so the thread has some code around it
const MAX_REMEMBERED_DIFFS = 24 // guard map bound: forget the oldest keyed diff

type Loc =
	| { kind: 'visible' }
	| {
			kind: 'collapsed'
			regionIndex: number
			distFromTop: number
			distFromBottom: number
	  }
	| { kind: 'missing' }

type Hunk = FileDiffMetadata['hunks'][number]

function hunkStart(hunk: Hunk, side: Side): number {
	return side === 'additions' ? hunk.additionStart : hunk.deletionStart
}

function hunkCount(hunk: Hunk, side: Side): number {
	return side === 'additions' ? hunk.additionCount : hunk.deletionCount
}

// Where `line` sits relative to one hunk: inside its collapsed-before region, on the hunk, or neither.
function hunkLoc(
	hunk: Hunk,
	index: number,
	side: Side,
	line: number,
): Loc | null {
	if (hunk.collapsedBefore > 0) {
		const gapStart = hunkStart(hunk, side) - hunk.collapsedBefore
		const gapEnd = hunkStart(hunk, side) - 1
		if (line >= gapStart && line <= gapEnd)
			return {
				kind: 'collapsed',
				regionIndex: index,
				distFromTop: line - gapStart + 1,
				distFromBottom: gapEnd - line + 1,
			}
	}
	const start = hunkStart(hunk, side)
	if (line >= start && line <= start + hunkCount(hunk, side) - 1)
		return { kind: 'visible' }
	return null
}

// Where a DISPLAY-space line currently sits in the rendered diff.
export function locateDisplayLine(
	fd: FileDiffMetadata,
	side: Side,
	line: number,
): Loc {
	for (let i = 0; i < fd.hunks.length; i++) {
		const loc = hunkLoc(fd.hunks[i], i, side, line)
		if (loc) return loc
	}
	const last = fd.hunks.at(-1)
	if (!last) return { kind: 'missing' }
	const lastEnd = hunkStart(last, side) + hunkCount(last, side) - 1
	const total =
		side === 'additions' ? fd.additionLines.length : fd.deletionLines.length
	if (line > lastEnd && line <= total)
		return {
			kind: 'collapsed',
			regionIndex: fd.hunks.length,
			distFromTop: line - lastEnd,
			distFromBottom: total - line + 1,
		}
	return { kind: 'missing' }
}

// Expand the collapsed region containing this RAW line (no-op if it already renders).
export function revealLine(side: Side, rawLine: number): void {
	if (S.settings.unchangedLines === 'expand') return // everything renders already
	const fd = D.fileDiff
	const inst = D.instance
	if (!fd || !inst) return
	const loc = locateDisplayLine(fd, side, toDisplayLine(side, rawLine))
	if (loc.kind !== 'collapsed') return
	const fromTop = loc.distFromTop <= loc.distFromBottom
	inst.expandHunk(
		loc.regionIndex,
		fromTop ? 'up' : 'down',
		(fromTop ? loc.distFromTop : loc.distFromBottom) + REVEAL_CONTEXT,
	)
}

// Once-per-rendered-diff guard: expandHunk triggers its own rerender, and our render()
// runs again on every decision - without this each pass would re-expand cumulatively.
const revealed = new Map<string, Set<string>>()

// Drop the oldest remembered diff once the guard map hits its bound.
function forgetOldestDiff(): void {
	const oldest = revealed.keys().next().value
	if (!oldest) return
	revealed.delete(oldest)
}

function doneFor(diffKey: string): Set<string> {
	const existing = revealed.get(diffKey)
	if (existing) return existing
	const done = new Set<string>()
	revealed.set(diffKey, done)
	// Keep the guard map from growing unboundedly across many files/option changes.
	if (revealed.size > MAX_REMEMBERED_DIFFS) forgetOldestDiff()
	return done
}

export function revealThreadLines(diffKey: string): void {
	const file = currentFileOrNull()
	if (!file) return
	const done = doneFor(diffKey)
	const seen = new Set<string>()
	for (const c of currentComments()) {
		if (c.status !== 'open' || isUnanchored(c, file)) continue
		const key = `${c.side}:${c.lineNumber}`
		if (seen.has(key) || done.has(key)) continue
		seen.add(key)
		done.add(key)
		revealLine(c.side, c.lineNumber)
	}
}
