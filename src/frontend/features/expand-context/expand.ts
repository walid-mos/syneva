import {
	currentComments,
	currentFileOrNull,
	isFileComment,
	isUnanchored,
	toDisplayLine,
} from '@entities/review/changes'
import { featureCtx } from '@features/context'

import { revealThreads } from './thread-reveals'

import type { FileDiffMetadata } from '@pierre/diffs'
import type { Side } from '@shared/diff-renderer/types'

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
	if (featureCtx().diffInstance()?.options.expandUnchanged) return // the actual view, including the expand cap
	const fd = featureCtx().fileDiff()
	const inst = featureCtx().diffInstance()
	if (!fd || !inst) return
	const loc = locateDisplayLine(
		fd,
		side,
		toDisplayLine(side, rawLine, featureCtx().lineMap()),
	)
	if (loc.kind !== 'collapsed') return
	const fromTop = loc.distFromTop <= loc.distFromBottom
	inst.expandHunk(
		loc.regionIndex,
		fromTop ? 'up' : 'down',
		(fromTop ? loc.distFromTop : loc.distFromBottom) + REVEAL_CONTEXT,
	)
}

export function revealThreadLines(): void {
	const file = currentFileOrNull(
		featureCtx().S.state?.files,
		featureCtx().S.preview,
		featureCtx().S.fileIndex,
	)
	const instance = featureCtx().diffInstance()
	if (!file || !instance) return
	// Whole-file comments anchor to the header, not a rendered line - nothing to reveal.
	const threads = currentComments(
		featureCtx().S.state,
		currentFileOrNull(
			featureCtx().S.state?.files,
			featureCtx().S.preview,
			featureCtx().S.fileIndex,
		),
	).filter(
		comment =>
			comment.status === 'open' &&
			!isFileComment(comment) &&
			!isUnanchored(comment, file),
	)
	revealThreads(instance, threads, revealLine)
}
