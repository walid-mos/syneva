import { toDisplayLine } from '@entities/review/changes'
import { deleteComment, editComment } from '@features/manage-comment/comments'
import {
	buildComposer,
	buildEditor,
	composerTargets,
	openComposer,
	openFileComposer,
} from '@features/manage-comment/composer'
import { esc } from '@shared/lib/esc'
import { notifyStateMutation } from '@shared/lib/reactive'
import { render } from '@shared/lib/render-scheduler'
import { renderCommentBody } from '@shared/markdown'

import { awaitingHtml } from '../awaiting'
import { diffCtx } from '../context'
import { D } from '../runtime'

import type { ThreadMeta } from '@entities/review/annotations'
import type { ReviewComment } from '@entities/review/model'

const MILLISECONDS_PER_SECOND = 1000
// Below this age a message reads as "now" rather than as a rounded unit.
const NOW_WINDOW_S = 45
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const DAYS_PER_WEEK = 7

// Coarse relative time for a message ("now", "5m ago", "3h ago", "2d ago", else a date). The
// thread rebuilds on every render/poll, so this refreshes often enough without a live ticker.
function relTime(iso?: string): string {
	if (!iso) return ''
	const t = +new Date(iso)
	if (!Number.isFinite(t)) return ''
	const elapsedS = Math.max(0, (Date.now() - t) / MILLISECONDS_PER_SECOND)
	if (elapsedS < NOW_WINDOW_S) return 'now'
	const elapsedMin = elapsedS / SECONDS_PER_MINUTE
	if (elapsedMin < MINUTES_PER_HOUR) return `${Math.round(elapsedMin)}m ago`
	const elapsedH = elapsedMin / MINUTES_PER_HOUR
	if (elapsedH < HOURS_PER_DAY) return `${Math.round(elapsedH)}h ago`
	const elapsedD = elapsedH / HOURS_PER_DAY
	if (elapsedD < DAYS_PER_WEEK) return `${Math.round(elapsedD)}d ago`
	return new Date(iso).toLocaleDateString()
}

// Only the reviewer's own messages carry intent badges and edit/delete actions.
function intentBadge(message: ReviewComment, isOwn: boolean): string {
	if (!isOwn) return ''
	if (message.intent === 'question')
		return '<span class="intent-badge q">Question</span>'
	if (message.intent === 'action')
		return '<span class="intent-badge a">Change requested</span>'
	return ''
}

// One message row: author, intent badge, relative time, edit/delete actions, body, and the
// awaiting indicator for a question no agent reply has followed yet. The body is left empty for
// the message being edited - buildCommentThread mounts the editor into it (it needs live DOM
// wiring, not an innerHTML string).
function messageHtml(message: ReviewComment, thread: ThreadMeta): string {
	const isOwn = message.role !== 'agent'
	const isEditing = diffCtx().S.editingCommentId === message.id
	const isEdited =
		message.updatedAt &&
		message.createdAt &&
		message.updatedAt !== message.createdAt
	const edited = isEdited ? ' · edited' : ''
	const badge = intentBadge(message, isOwn)
	// A question is "answered" once an agent reply lands after it in this thread.
	const isAwaiting =
		isOwn &&
		message.intent === 'question' &&
		!thread.comments.some(
			x =>
				x.role === 'agent' &&
				+new Date(x.createdAt) > +new Date(message.createdAt),
		)
	const actions =
		isOwn && !isEditing
			? `<span class="msg-actions"><button class="edit-comment" data-id="${message.id}">Edit</button><button class="delete-comment" data-id="${message.id}">Delete</button></span>`
			: ''
	const body = isEditing
		? ''
		: `<div class="md">${renderCommentBody(message)}</div>`
	const classes = `msg ${isOwn ? '' : 'agent'}${isEditing ? ' editing' : ''}`
	return `<div class="${classes}" data-id="${message.id}"><div class="meta"><span class="author ${isOwn ? '' : 'agent'}">${isOwn ? 'You' : 'Agent'}</span>${badge}<time>${esc(relTime(message.createdAt))}${edited}</time>${actions}</div>${body}${isAwaiting ? awaitingHtml() : ''}</div>`
}

// A resolved thread collapses to its summary line; an open one renders its messages oldest-first.
function messagesHtml(thread: ThreadMeta): string {
	if (thread.status !== 'resolved')
		return thread.comments.map(m => messageHtml(m, thread)).join('')
	const count = thread.comments.length
	const plural = count === 1 ? '' : 's'
	return `<div class="thread-summary"><b>${count}</b> comment${plural} <span>(Resolved)</span><button class="reopen-inline">Reopen</button></div>`
}

// Reply hides while its own composer is open (only Resolve stays); the composer card sits between
// the last message and the action bar.
function threadFoot(thread: ThreadMeta, isReplyOpen: boolean): string {
	if (thread.status === 'resolved')
		return '<div class="thread-actions"><button class="reopen-thread">Reopen</button></div>'
	if (isReplyOpen)
		return '<div class="thread-actions"><button class="resolve-thread">Resolve</button></div>'
	return '<div class="thread-actions"><button class="reply-thread">Reply</button><button class="resolve-thread">Resolve</button></div>'
}

// Flip every comment of the thread's anchor (the whole thread moves together) and repaint.
function setThreadStatus(
	thread: ThreadMeta,
	status: ReviewComment['status'],
): void {
	for (const comment of diffCtx().requireState().comments) {
		const isSameAnchor =
			comment.path === thread.path &&
			comment.side === thread.side &&
			comment.lineNumber === thread.lineNumber
		if (isSameAnchor) comment.status = status
	}
	// The loop's elements are raw (bound-raw array iteration - see notifyStateMutation),
	// so the status writes never bump the store themselves.
	notifyStateMutation()
}

// A whole-file thread hosts its reply through the file composer (no line anchor to select);
// its open state is the file composer's flag. A line thread keeps the existing check.
function isReplyComposerOpen(thread: ThreadMeta): boolean {
	if (thread.fileLevel)
		return (
			diffCtx().S.fileComposerOpen &&
			!diffCtx().S.editingCommentId &&
			thread.status === 'open'
		)
	return composerTargets(thread.side, thread.lineNumber)
}

function wireThreadActions(box: HTMLElement, thread: ThreadMeta): void {
	const reply = box.querySelector<HTMLButtonElement>('.reply-thread')
	reply?.addEventListener('click', () => {
		if (thread.fileLevel) {
			openFileComposer()
			return
		}
		// diffCtx().S.selected is display space; the thread's anchor is raw.
		diffCtx().S.selected = {
			side: thread.side,
			lineNumber: toDisplayLine(
				thread.side,
				thread.lineNumber,
				D.lineMap,
			),
		}
		openComposer()
	})
	for (const button of box.querySelectorAll<HTMLButtonElement>(
		'.edit-comment',
	)) {
		const { id } = button.dataset
		if (id) button.addEventListener('click', () => editComment(id))
	}
	for (const button of box.querySelectorAll<HTMLButtonElement>(
		'.delete-comment',
	)) {
		const { id } = button.dataset
		if (id) button.addEventListener('click', () => deleteComment(id))
	}
	box.querySelector<HTMLButtonElement>('.resolve-thread')?.addEventListener(
		'click',
		() => {
			// The notes flow (panel open) hears the resolve before the flip - same contract as
			// the keyboard resolve (cursor.ts), so the button path arms the advance too.
			diffCtx().S.noteResolved?.({
				path: thread.path,
				side: thread.side,
				lineNumber: thread.lineNumber,
				fileLevel: Boolean(thread.fileLevel),
			})
			setThreadStatus(thread, 'resolved')
			void render()
			diffCtx().toast('Resolved')
			diffCtx().persist()
		},
	)
	for (const button of box.querySelectorAll<HTMLButtonElement>(
		'.reopen-thread,.reopen-inline',
	)) {
		// A resolved thread renders the summary's inline Reopen AND the actions-bar Reopen -
		// give both a listener (querySelector would bind only the first).
		button.addEventListener('click', () => {
			setThreadStatus(thread, 'open')
			void render()
			diffCtx().toast('Reopened')
			diffCtx().persist()
		})
	}
}

// The comment-box element for one thread (messages + reply/resolve/reopen + per-message
// edit/delete). Shared by the diff annotations, the file header and the markdown-file view.
export function buildCommentThread(thread: ThreadMeta): HTMLElement {
	const box = document.createElement('div')
	box.className = 'comment-box'
	const isReplyOpen = isReplyComposerOpen(thread)
	box.innerHTML = `${messagesHtml(thread)}${threadFoot(thread, isReplyOpen)}`
	// Mount the in-place editor into the message being edited.
	if (diffCtx().S.editingCommentId && thread.status !== 'resolved') {
		const message = box.querySelector(
			`.msg[data-id="${diffCtx().S.editingCommentId}"]`,
		)
		message?.appendChild(buildEditor())
	}
	// Mount the reply composer above the action bar.
	if (isReplyOpen && thread.status !== 'resolved')
		box.querySelector('.thread-actions')?.before(buildComposer())
	wireThreadActions(box, thread)
	return box
}
