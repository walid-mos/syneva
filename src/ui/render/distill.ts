import type { ContextContent, FileDiffMetadata } from '@pierre/diffs'
import type { DecidedPosition } from '../linemap'

// ── Distilling accepted bands out of the replayed diff ──────────────────────
// With the "hide accepted" pref on, a decision that was already ACCEPTED repeats round
// after round (multi-round reviews): its band replays into a plain context run that just
// sits in the diff. This transform drops those rows from the rendered structure entirely:
// each accepted entry becomes a zero-row context placeholder, so positions stay invariant
// (the same trick @pierre's resolveRegion uses for deleted indexes) and every consumer of
// the metadata - display anchors, annotations, cursor, windowing - keeps working unchanged.
//
// Pure over the metadata: the walk mirrors resolveRegion's cursor mechanics (both sides'
// line arrays, the per-hunk counters and start numbers, collapsed context regions),
// minus pushed rows for dropped entries. Accepted bands are EQUAL merged context runs on
// both sides after replay, so a dropped entry just skips `lines` rows on each side - the
// two side counters advance in lockstep through the whole walk.

type Line = FileDiffMetadata['deletionLines'][number]
type ContentEntry = FileDiffMetadata['hunks'][number]['hunkContent'][number]

const entryKey = (hunkIndex: number, changeIndex: number): string =>
	`${hunkIndex}:${changeIndex}`

// The kept context rows of one entry: the SAME parsed line object rides both arrays
// (resolveRegion's pushContentLinesToDiff contract), read back from the source.
function contextRows(entry: ContextContent, from: FileDiffMetadata): Line[] {
	const rows: Line[] = []
	for (let i = 0; i < entry.lines; i++)
		rows.push(
			from.additionLines[entry.additionLineIndex + i] ??
				from.deletionLines[entry.deletionLineIndex + i],
		)
	return rows
}

export function distillAccepted(
	diff: FileDiffMetadata,
	cuts: DecidedPosition[],
): FileDiffMetadata {
	if (!cuts.length) return diff
	const cutSet = new Set(
		cuts.map(cut => entryKey(cut.hunkIndex, cut.changeIndex)),
	)
	const deletionRows: Line[] = []
	const additionRows: Line[] = []
	// resolveRegion's cursor: the next row's index on each side (also the arrays' lengths)
	// plus the file-line starts the gutters show. One pass drives both through every hunk.
	let deletionLength = 0
	let additionLength = 0
	let nextDeletionStart = 1
	let nextAdditionStart = 1
	let splitLineCount = 0
	let unifiedLineCount = 0
	const hunks = diff.hunks.map((hunk, hunkIndex) => {
		// Collapsed context ahead of the hunk (resolveRegion's processCollapsedContext):
		// the "N unmodified lines" separator rows ride both sides, one line per side.
		const collapseRows =
			hunk.collapsedBefore > 0 && !diff.isPartial
				? hunk.collapsedBefore
				: 0
		for (let i = 0; i < collapseRows; i++) {
			deletionRows.push(
				diff.deletionLines[hunk.deletionLineIndex - collapseRows + i],
			)
			additionRows.push(
				diff.additionLines[hunk.additionLineIndex - collapseRows + i],
			)
		}
		deletionLength += collapseRows
		additionLength += collapseRows
		nextDeletionStart += collapseRows
		nextAdditionStart += collapseRows
		splitLineCount += collapseRows
		unifiedLineCount += collapseRows
		const content: ContentEntry[] = []
		const open = {
			additionStart: nextAdditionStart,
			deletionStart: nextDeletionStart,
			additionLineIndex: additionLength,
			deletionLineIndex: deletionLength,
			splitLineStart: splitLineCount,
			unifiedLineStart: unifiedLineCount,
		}
		const totals = {
			additionCount: 0,
			deletionCount: 0,
			additionLines: 0,
			deletionLines: 0,
			splitLineCount: 0,
			unifiedLineCount: 0,
		}
		hunk.hunkContent.forEach((entry, changeIndex) => {
			if (cutSet.has(entryKey(hunkIndex, changeIndex))) {
				// Zero-row placeholder: keeps the content slot - and with it every
				// consumer's (hunkIndex, changeIndex) addressing - while rendering
				// nothing. Nothing advances.
				content.push({
					type: 'context',
					lines: 0,
					deletionLineIndex: open.deletionLineIndex,
					additionLineIndex: open.additionLineIndex,
				} satisfies ContextContent)
				return
			}
			content.push({
				...entry,
				deletionLineIndex: deletionLength,
				additionLineIndex: additionLength,
			})
			if (entry.type === 'context') {
				for (const line of contextRows(entry, diff)) {
					deletionRows.push(line)
					additionRows.push(line)
				}
				deletionLength += entry.lines
				additionLength += entry.lines
				nextDeletionStart += entry.lines
				nextAdditionStart += entry.lines
				splitLineCount += entry.lines
				unifiedLineCount += entry.lines
				totals.additionCount += entry.lines
				totals.deletionCount += entry.lines
				totals.splitLineCount += entry.lines
				totals.unifiedLineCount += entry.lines
				return
			}
			const rows = Math.max(entry.deletions, entry.additions)
			for (let i = 0; i < rows; i++) {
				if (i < entry.deletions) {
					const line = diff.deletionLines[entry.deletionLineIndex + i]
					if (!line)
						throw new Error(
							`distill: missing deletion row ${entry.deletionLineIndex + i}`,
						)
					deletionRows.push(line)
				}
				if (i < entry.additions) {
					const line = diff.additionLines[entry.additionLineIndex + i]
					if (!line)
						throw new Error(
							`distill: missing addition row ${entry.additionLineIndex + i}`,
						)
					additionRows.push(line)
				}
			}
			deletionLength += entry.deletions
			additionLength += entry.additions
			nextDeletionStart += entry.deletions
			nextAdditionStart += entry.additions
			splitLineCount += rows
			unifiedLineCount += entry.deletions + entry.additions
			totals.additionCount += entry.additions
			totals.deletionCount += entry.deletions
			totals.additionLines += entry.additions
			totals.deletionLines += entry.deletions
			totals.splitLineCount += rows
			totals.unifiedLineCount += entry.deletions + entry.additions
		})
		return {
			...hunk,
			hunkContent: content,
			...open,
			...totals,
			splitLineCount: splitLineCount - open.splitLineStart,
			unifiedLineCount: unifiedLineCount - open.unifiedLineStart,
		}
	})
	// Trailing collapsed context after the last hunk (resolveRegion's tail push): display
	// rows only - the counters are done accounting hunks.
	const last = diff.hunks.at(-1)
	if (last && !diff.isPartial) {
		const deletionEnd = last.deletionLineIndex + last.deletionCount
		const additionEnd = last.additionLineIndex + last.additionCount
		const count = Math.min(
			diff.deletionLines.length - deletionEnd,
			diff.additionLines.length - additionEnd,
		)
		for (let i = 0; i < count; i++) {
			deletionRows.push(diff.deletionLines[deletionEnd + i])
			additionRows.push(diff.additionLines[additionEnd + i])
		}
	}
	return {
		...diff,
		hunks,
		deletionLines: deletionRows,
		additionLines: additionRows,
		splitLineCount,
		unifiedLineCount,
	}
}
