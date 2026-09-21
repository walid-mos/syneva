import { openEditor } from '@entities/review/api'
import { currentFileOrNull, fromDisplayLine } from '@entities/review/changes'
import { featureCtx } from '@features/context'

// Jump from the desk into the local editor at the cursor's line. The cursor (and featureCtx().S.selected)
// hold DISPLAY coordinates - replayed decisions renumber the rendered diff - so convert to
// the real file line before handing it to an external process.
export async function openInEditor(): Promise<void> {
	const file = currentFileOrNull(
		featureCtx().S.state?.files,
		featureCtx().S.preview,
		featureCtx().S.fileIndex,
	)
	if (!file) {
		featureCtx().toast('No file selected')
		return
	}
	const selection = featureCtx().cursorSelection() ?? featureCtx().S.selected
	const lineNumber = fromDisplayLine(
		selection.side,
		selection.lineNumber,
		featureCtx().lineMap(),
	)
	try {
		const reply = await openEditor({ path: file.path, lineNumber })
		const failure = reply.error ?? 'Could not open editor'
		featureCtx().toast(reply.ok ? 'Opened in editor' : failure)
	} catch {
		featureCtx().toast('Could not open editor')
	}
}
