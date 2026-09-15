import { toDisplayLine } from './changes'
import { render } from './render'
import { persist, requireState, S, toast } from './store'

// Edit & delete the reviewer's own comments. Agent replies (role "agent") are
// read-only and never get edit/delete affordances, but we guard here too.

export function editComment(id: string): void {
	const comment = requireState().comments.find(c => c.id === id)
	if (!comment || comment.role === 'agent') return
	S.composerBody = comment.body
	S.editingCommentId = id
	// A whole-file comment edits inside its header thread (the file composer); a line comment
	// anchors on its line (the line composer). Exactly one of the two flags ends up up.
	if (comment.anchor === 'file') {
		S.composerOpen = false
		S.fileComposerOpen = true
	} else {
		S.fileComposerOpen = false
		S.composerOpen = true
		// Comments persist raw lines; S.selected is display space. The edit renders in place
		// inside the thread (see buildCommentThread) - render() mounts it and restores focus.
		S.selected = {
			side: comment.side,
			lineNumber: toDisplayLine(comment.side, comment.lineNumber),
		}
	}
	void render()
}

export function deleteComment(id: string): void {
	const state = requireState()
	const comment = state.comments.find(c => c.id === id)
	if (!comment || comment.role === 'agent') return
	if (S.editingCommentId === id) {
		S.editingCommentId = null
		S.composerOpen = false
		S.fileComposerOpen = false
	}
	state.comments = state.comments.filter(c => c.id !== id)
	void render()
	// The saver is burst-debounced; the next /api/state poll reconciles against the desk, which
	// still holds the comment until the save lands, so a re-add is bounded by that merge.
	persist()
	toast('Comment deleted')
}
