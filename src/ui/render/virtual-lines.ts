import type { FileDiffMetadata, HunkExpansionRegion } from '@pierre/diffs'
import type { Row } from '../cursor-rows'
import type { DiffStyle, Side } from '../types'

type LineOptions = {
	style: DiffStyle
	expanded: Map<number, HunkExpansionRegion> | true
	threshold: number
}
type Segment = {
	additionLineIndex: number
	deletionLineIndex: number
	additions: number
	deletions: number
	isChange: boolean
}

function row(side: Side, line: number, isChange: boolean): Row {
	return { side, line, change: isChange, top: 0, height: 0 }
}

function pairedRows(segment: Segment): Row[] {
	return Array.from(
		{ length: Math.max(segment.additions, segment.deletions) },
		(_, index) => {
			const hasAddition = index < segment.additions
			const primary = row(
				hasAddition ? 'additions' : 'deletions',
				(hasAddition
					? segment.additionLineIndex
					: segment.deletionLineIndex) +
					index +
					1,
				segment.isChange,
			)
			if (hasAddition && index < segment.deletions)
				primary.alt = {
					side: 'deletions',
					line: segment.deletionLineIndex + index + 1,
				}
			return primary
		},
	)
}

function segmentRows(segment: Segment, style: DiffStyle): Row[] {
	if (!segment.isChange || style === 'split') return pairedRows(segment)
	return [
		...Array.from({ length: segment.deletions }, (_, index) =>
			row('deletions', segment.deletionLineIndex + index + 1, true),
		),
		...Array.from({ length: segment.additions }, (_, index) =>
			row('additions', segment.additionLineIndex + index + 1, true),
		),
	]
}

function gapRows(segment: Segment, index: number, options: LineOptions): Row[] {
	const count = segment.additions
	const expansion =
		options.expanded === true
			? { fromStart: count, fromEnd: 0 }
			: options.expanded.get(index)
	const start = Math.min(count, Math.max(0, expansion?.fromStart ?? 0))
	const end = Math.min(count, Math.max(0, expansion?.fromEnd ?? 0))
	if (count <= options.threshold || start + end >= count)
		return pairedRows(segment)
	return [
		...pairedRows({ ...segment, additions: start, deletions: start }),
		...pairedRows({
			...segment,
			additionLineIndex: segment.additionLineIndex + count - end,
			deletionLineIndex: segment.deletionLineIndex + count - end,
			additions: end,
			deletions: end,
		}),
	]
}

function hunkRows(
	hunk: FileDiffMetadata['hunks'][number],
	style: DiffStyle,
): Row[] {
	return hunk.hunkContent.flatMap(content => {
		const segment =
			content.type === 'change'
				? { ...content, isChange: true }
				: {
						...content,
						additions: content.lines,
						deletions: content.lines,
						isChange: false,
					}
		return segmentRows(segment, style)
	})
}

// Logical order is independent of mounted DOM. Folded context stays excluded, but scrolling
// a row out of the render window cannot make it disappear from keyboard navigation.
export function virtualLines(
	diff: FileDiffMetadata,
	options: LineOptions,
): Row[] {
	const rows: Row[] = []
	let additionEnd = 0
	let deletionEnd = 0
	for (const [index, hunk] of diff.hunks.entries()) {
		if (!diff.isPartial)
			rows.push(
				...gapRows(
					{
						additionLineIndex: additionEnd,
						deletionLineIndex: deletionEnd,
						additions: hunk.collapsedBefore,
						deletions: hunk.collapsedBefore,
						isChange: false,
					},
					index,
					options,
				),
			)
		rows.push(...hunkRows(hunk, options.style))
		additionEnd = hunk.additionLineIndex + hunk.additionCount
		deletionEnd = hunk.deletionLineIndex + hunk.deletionCount
	}
	if (!diff.isPartial)
		rows.push(
			...gapRows(
				{
					additionLineIndex: additionEnd,
					deletionLineIndex: deletionEnd,
					additions: diff.additionLines.length - additionEnd,
					deletions: diff.deletionLines.length - deletionEnd,
					isChange: false,
				},
				diff.hunks.length,
				options,
			),
		)
	return rows
}
