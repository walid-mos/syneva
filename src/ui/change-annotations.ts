import { currentChanges, toDisplayLine } from './changes'
import { isBlockSkimCollapsed, skimStripLabel } from './skim'

import type { AnnotationInput, ChangeState } from './types'

// The collapse/expand strip standing in for a skimmable block. While collapsed, skim.ts hides the
// block's rows and this strip is all that shows.
function skimAnnotation(
	ch: ChangeState,
	lineNumber: number,
	isCollapsed: boolean,
): AnnotationInput {
	return {
		side: ch.side,
		lineNumber,
		metadata: {
			type: 'skim',
			id: ch.id,
			side: ch.side,
			lineNumber,
			label: skimStripLabel(ch),
			collapsed: isCollapsed,
		},
	}
}

function changeAnnotation(
	ch: ChangeState,
	lineNumber: number,
): AnnotationInput {
	return {
		side: ch.side,
		lineNumber,
		metadata: {
			type: 'change',
			id: ch.id,
			side: ch.side,
			lineNumber: ch.lineNumber,
			title: ch.title,
			path: ch.path,
		},
	}
}

// A pending change: a skimmable block gets its strip, and its decision bar is suppressed while
// that strip is collapsed (the bar returns on expand - isBlockSkimCollapsed owns the default, so
// reading S.skimExpanded directly here would diverge from the row hiding).
function pushChange(annotations: AnnotationInput[], ch: ChangeState): void {
	const lineNumber =
		ch.displayEndLine ?? toDisplayLine(ch.side, ch.endLine ?? ch.lineNumber)
	if (ch.skim) {
		const isCollapsed = isBlockSkimCollapsed(ch)
		annotations.push(skimAnnotation(ch, lineNumber, isCollapsed))
		if (isCollapsed) return
	}
	annotations.push(changeAnnotation(ch, lineNumber))
}

export function changeAnnotations(
	coveredChangeIds: Set<string>,
): AnnotationInput[] {
	const annotations: AnnotationInput[] = []
	for (const ch of currentChanges()) {
		if (ch.status !== 'pending' || coveredChangeIds.has(ch.id)) continue
		pushChange(annotations, ch)
	}
	return annotations
}
