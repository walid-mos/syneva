import { currentFileOrNull } from '@entities/review/changes'
import { notesPanelView } from '@entities/review/notes'
import {
	jumpTargetFor,
	jumpToThread,
	setPendingJump,
} from '@widgets/diff-view/comment-jump'

import { requireState, S } from '../store'

import type { NotesView, ReviewNote } from '@entities/review/notes'

// The panel's view inputs, read from the store at each derivation - the same shape the
// component passes to notesPanelView, so both sides derive one visible list.
const notesView = (): NotesView => ({ query: S.notesQuery, lens: S.notesLens })

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
	// The panel's cursor state lives on the store; the visible rows come from
	// notesPanelView - the same derivation the component renders, so the cursor and
	// the screen can never drift apart.
	S.setNotesQuery = query => {
		// A new view is a new list: the cursor restarts at the top row.
		S.notesQuery = query
		S.notesCursor = 0
	}
	S.setNotesLens = lens => {
		S.notesLens = lens
		S.notesCursor = 0
	}
	S.notesCursorMove = dir => {
		S.notesCursor = Math.max(0, S.notesCursor + dir)
		const last = notesPanelView(S.state, notesView()).flat.length - 1
		S.notesCursor = Math.min(S.notesCursor, Math.max(last, 0))
	}
	S.notesJumpCursor = () => {
		const note = notesPanelView(S.state, notesView()).flat[S.notesCursor]
		if (note) jumpToNote(note)
	}
	S.notesFocusSearch = () => {
		S.notesSearchTick++
	}
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
