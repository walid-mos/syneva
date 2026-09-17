import { currentChanges, toDisplayLine } from './changes'

import type { AnnotationInput, ChangeState } from './types'

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
				toDisplayLine(ch.side, ch.endLine ?? ch.lineNumber),
		),
	)
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
