import {
	currentFileComments,
	currentFileOrNull,
	hasCurrentFile,
	fromDisplayLine,
} from '../changes'
import { toggleFileComposer } from '../composer'
import { cur } from '../contents'
import { fileCommentsEnabled } from '../file-comments'
import { render } from '../render'
import { closeComposerIfEmpty } from '../selection'
import { api, persist, requireState, S, toast } from '../store'
import { uuid } from '../uuid'

// Submitting a comment from the inline composer. A new comment carries an intent: "question"
// (Ask - pushed to the agent now via /api/ask, answered live) or "action" (Request change - goes
// back on Send). Editing just updates the body and keeps the existing intent. The whole-file
// composer binds here too: the guide bar's and file header's comment icons toggle it.
export function installCommentBindings(): void {
	S.saveComment = () => submitComment('action') // editing Save + the `c` shortcut default
	S.ask = () => submitComment('question')
	S.requestChange = () => submitComment('action')
	S.toggleFileComposer = toggleFileComposer
	// The guide bar's static icon shows when there's a file to comment on and the whole-file
	// scope adds something over the line threads (hidden on the Overview and single-file desks).
	S.fileCommentAvailable = (): boolean =>
		hasCurrentFile() && fileCommentsEnabled()
	S.openFileCommentCount = () =>
		currentFileComments().filter(
			c => c.status === 'open' && c.role !== 'agent',
		).length
	installComposerDismissal()
}

// Close the inline composer when clicking outside it (unless it has unsaved text). The
// composer/editor live inside the diff DOM, so match their containers directly; the listener is on
// the document, capturing, so it sees the press before any diff control handles the click. The
// file header's comment icon toggles its own composer, so it is carved out of the dismissal.
function installComposerDismissal(): void {
	document.addEventListener(
		'pointerdown',
		event => {
			if (!S.composerOpen && !S.fileComposerOpen) return
			const { target } = event
			if (
				target instanceof HTMLElement &&
				target.closest('.composer-card, .msg-edit, .fc-btn, .gb-fc')
			)
				return
			// Defer the closing render: this fires on pointerdown, before the click reaches a diff
			// control (Keep/Undo/Reply). Rendering now rebuilds the diff and destroys that control, so
			// the browser drops the pending click and the user's press is swallowed.
			closeComposerIfEmpty(true)
		},
		true,
	)
}

type CommentIntent = 'question' | 'action'

function submitComment(intent: CommentIntent): void {
	const body = (S.composerBody || '').trim()
	if (!body) return
	if (S.editingCommentId) {
		updateEditedComment(body)
		return
	}
	// The file composer answers to the file header (no line anchor); the line composer to the
	// selected line. The open helpers keep exactly one of the two flags up.
	const anchor = S.fileComposerOpen ? fileAnchor() : selectedAnchor()
	if (!anchor) return
	const now = new Date().toISOString()
	const comment = {
		id: uuid(),
		path: anchor.path,
		side: anchor.side,
		lineNumber: anchor.lineNumber,
		endLine: anchor.endLine,
		// Snapshot the anchored line's text so a reload can re-anchor the thread after the agent's
		// edits shift it (reanchorComments).
		anchorText: anchor.anchorText,
		createdAt: now,
		updatedAt: now,
		status: 'open' as const,
		role: 'user' as const,
		body,
		intent,
		anchor: anchor.anchor,
	}
	requireState().comments.push(comment)
	S.composerOpen = false
	S.fileComposerOpen = false
	void render()
	persist()
	if (intent === 'question') {
		void api('/api/ask', {
			method: 'POST',
			body: JSON.stringify({
				path: comment.path,
				lineNumber: comment.lineNumber,
				side: comment.side,
				body,
			}),
		})
		toast('Asked - waiting for answer')
		return
	}
	toast('Comment saved')
}

// Rewrite the comment being edited in place (its intent and anchor stay as they were).
function updateEditedComment(body: string): void {
	const comment = requireState().comments.find(
		c => c.id === S.editingCommentId,
	)
	if (comment) {
		comment.body = body
		comment.updatedAt = new Date().toISOString()
	}
	S.editingCommentId = null
	S.composerOpen = false
	S.fileComposerOpen = false
	void render()
	persist()
	toast('Comment updated')
}

// The selection the composer targets, in the coordinates a persisted comment carries: S.selected is
// display space (replayed decisions renumber the rendered diff), so it converts through the line map.
// The anchor text comes from the current file's fetched contents (contents.ts `cur`) - best-effort,
// since the server re-derives its own anchorText on reload - so a `cur` for another file is left
// undefined rather than snapshotting the wrong file's line.
type CommentAnchor = {
	path: string
	side: 'additions' | 'deletions'
	lineNumber: number
	endLine?: number
	anchorText?: string
	anchor?: 'file'
}

// The whole-file anchor: addressed to the file, so no line - lineNumber 0 is the reserved
// file-level slot (mirrors state/comments.ts's FILE_LEVEL_LINE).
function fileAnchor(): CommentAnchor | null {
	const file = currentFileOrNull()
	if (!file) return null
	return { path: file.path, side: 'additions', lineNumber: 0, anchor: 'file' }
}

function selectedAnchor(): CommentAnchor | null {
	const file = currentFileOrNull()
	if (!file) return null
	const { side, lineNumber, endLine } = S.selected
	const anchor: CommentAnchor = {
		path: file.path,
		side,
		lineNumber: fromDisplayLine(side, lineNumber),
	}
	if (typeof endLine === 'number')
		anchor.endLine = fromDisplayLine(side, endLine)
	if (cur.path === file.path) {
		const contents =
			side === 'deletions' ? cur.oldContents : cur.newContents
		anchor.anchorText = contents.split('\n')[anchor.lineNumber - 1]
	}
	return anchor
}
