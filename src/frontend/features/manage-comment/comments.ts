import { toDisplayLine } from '@entities/review/changes'
import { featureCtx } from '@features/context'
import { render } from '@shared/lib/render-scheduler'

// Edit & delete the reviewer's own comments. Agent replies (role "agent") are
// read-only and never get edit/delete affordances, but we guard here too.

export function editComment(id: string): void {
	const comment = featureCtx()
		.requireState()
		.comments.find(c => c.id === id)
	if (!comment || comment.role === 'agent') return
	featureCtx().S.composerBody = comment.body
	featureCtx().S.editingCommentId = id
	// A whole-file comment edits inside its header thread (the file composer); a line comment
	// anchors on its line (the line composer). Exactly one of the two flags ends up up.
	if (comment.anchor === 'file') {
		featureCtx().S.composerOpen = false
		featureCtx().S.fileComposerOpen = true
	} else {
		featureCtx().S.fileComposerOpen = false
		featureCtx().S.composerOpen = true
		// Comments persist raw lines; featureCtx().S.selected is display space. The edit renders in place
		// inside the thread (see buildCommentThread) - render() mounts it and restores focus.
		featureCtx().S.selected = {
			side: comment.side,
			lineNumber: toDisplayLine(
				comment.side,
				comment.lineNumber,
				featureCtx().lineMap(),
			),
		}
	}
	void render()
}

export function deleteComment(id: string): void {
	const state = featureCtx().requireState()
	const comment = state.comments.find(c => c.id === id)
	if (!comment || comment.role === 'agent') return
	if (featureCtx().S.editingCommentId === id) {
		featureCtx().S.editingCommentId = null
		featureCtx().S.composerOpen = false
		featureCtx().S.fileComposerOpen = false
	}
	state.comments = state.comments.filter(c => c.id !== id)
	void render()
	// The saver is burst-debounced; the next /api/state poll reconciles against the desk, which
	// still holds the comment until the save lands, so a re-add is bounded by that merge.
	featureCtx().persist()
	featureCtx().toast('Comment deleted')
}
