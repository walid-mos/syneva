import { currentFileOrNull } from '@entities/review/changes'
import {
	jumpTargetFor,
	jumpToThread,
	setPendingJump,
} from '@widgets/diff-view/comment-jump'

import { requireState, S } from '../store'

import type { ReviewNote } from '@entities/review/notes'

// The review-notes panel's actions: toggling it, and jumping to a note. The jump is the
// feature's point - a question asked three files ago is one click from anywhere, instead
// of a walk back through every file. Same-file notes land immediately; other-file notes
// select the file (or open it as a preview, for notes on unchanged files) and stash a
// pending jump the render funnel consumes once the target is actually on screen.
export function installNotesBindings(): void {
	S.toggleNotes = () => {
		S.notesOpen = !S.notesOpen
	}
	S.jumpToNote = jumpToNote
}

function jumpToNote(note: ReviewNote): void {
	const state = requireState()
	const target = jumpTargetFor(note)
	const current = currentFileOrNull(state.files, S.preview, S.fileIndex)
	if (current?.path === note.path) {
		jumpToThread(current, target)
		return
	}
	// The file may have left the review (its comments survive the round), in which case
	// the only way back to it is the read-only preview - comments anchor there like on
	// any file.
	const index = state.files.findIndex(f => f.path === note.path)
	setPendingJump(target)
	if (index >= 0) S.selectFile?.(index)
	else S.previewFile?.(note.path)
}
