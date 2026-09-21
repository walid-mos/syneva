import {
	currentChanges,
	toDisplayLine,
	currentFileOrNull,
} from '@entities/review/changes'

import { diffCtx } from './context'
import { D } from './runtime'

import type { ChangeState } from '@entities/review/model'
import type { AnnotationInput } from './types'

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

// Every pending change carries its accept/reject bar under the block's last display line.
function pushChange(annotations: AnnotationInput[], ch: ChangeState): void {
	annotations.push(
		changeAnnotation(
			ch,
			ch.displayEndLine ??
				toDisplayLine(ch.side, ch.endLine ?? ch.lineNumber, D.lineMap),
		),
	)
}

export function changeAnnotations(
	coveredChangeIds: Set<string>,
): AnnotationInput[] {
	const annotations: AnnotationInput[] = []
	for (const ch of currentChanges(
		diffCtx().S.state,
		currentFileOrNull(
			diffCtx().S.state?.files,
			diffCtx().S.preview,
			diffCtx().S.fileIndex,
		),
	)) {
		if (ch.status !== 'pending' || coveredChangeIds.has(ch.id)) continue
		pushChange(annotations, ch)
	}
	return annotations
}
