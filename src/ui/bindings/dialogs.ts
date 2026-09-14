import { confirmNo, confirmYes } from '../confirm'
import { walkthroughRows } from '../guide'
import { helpGroups } from '../keys'
import { isCurrentDesk } from '../poll'
import { reviewStats } from '../progress'
import { render } from '../render'
import { reviewerSlice } from '../save'
import { $, api, D, requireState, S, toast } from '../store'

import type { BrowserResetResponse } from '../../types'

// The modal bindings: the Send receipt (a glance at what is about to go, one-way), the
// review-complete prompt, Reset, and the keyboard-help + confirm dialogs.

// Pluralize a count with its noun: plural(1, "file") -> "1 file", plural(3, "file") -> "3 files".
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// The one-line receipt of a review's scope: files, changed lines, and the comments/rejections that
// explain why it is not simply "all clean".
function reviewReceipt(): string {
	const { files, lines, comments, rejections } = reviewStats()
	return [
		plural(files, 'file'),
		plural(lines, 'changed line'),
		comments ? plural(comments, 'comment') : '',
		rejections ? plural(rejections, 'rejected hunk') : '',
	]
		.filter(Boolean)
		.join(', ')
}

// Open the Send modal: a receipt of what is about to go, plus an empty (always fresh) note box. An
// attached agent picks the review up the instant it is sent, so there is no taking it back - this is
// the moment to look, and to leave an overall instruction for the whole review.
function openSendModal(message: string): void {
	S.sendMsg = message
	S.sendNote = ''
	S.sendOpen = true
	setTimeout(() => $('sendNote').focus(), 0) // after Alpine shows it (mirrors the composer)
}

export function installDialogBindings(): void {
	installSendBindings()
	installHelpBindings()
}

function installSendBindings(): void {
	// Fired after the last file is approved - a small receipt of the work done (files, lines,
	// comments, rejections) plus the offer to send the finished review back to the agent.
	S.promptFinish = () => {
		const { files, lines, comments, rejections } = reviewStats()
		const extras = [
			comments ? plural(comments, 'comment') : '',
			rejections ? plural(rejections, 'rejected hunk') : '',
		].filter(Boolean)
		const what = files === 1 ? 'the file' : `all ${files} files`
		const tail = extras.length ? extras.join(', ') : 'all clean'
		openSendModal(
			`You've reviewed ${what} - ${plural(lines, 'changed line')}, ${tail}. Send the review back to the agent?`,
		)
	}
	// Every manual send - the Send button and ⇧S - routes through this receipt-style modal: a glance
	// at what is about to go before the one-way handoff.
	S.confirmSend = () => {
		openSendModal(
			`You're about to send your review: ${reviewReceipt()}. Send to the agent?`,
		)
	}
	// Confirm the Send modal: the typed note (trimmed; empty -> omitted) rides along as the one-time
	// overall instruction. Cancel leaves the review untouched.
	S.sendConfirm = () => {
		const note = S.sendNote.trim()
		S.sendOpen = false
		void S.send?.(note)
	}
	S.sendCancel = () => {
		S.sendOpen = false
		S.sendNote = ''
	}
	installResetBinding()
}

function installResetBinding(): void {
	S.reset = async () => {
		const body = await api<Partial<BrowserResetResponse>>('/api/reset', {
			method: 'POST',
		})
		if (body.state) {
			if (!isCurrentDesk(body.serverInstanceId)) return
			S.state = body.state
			D.fileDiff = null
			void render()
		}
		toast('Reset review')
	}
	installSendAction()
}

// The one-way handoff: post only the reviewer-owned slice, never the whole (multi-MB) ReviewState.
function installSendAction(): void {
	S.send = async (overallNote = '') => {
		// Big desks used to cross the server's body cap on Send and 500 ("Could not send review")
		// while the slice-only auto-saves kept succeeding; the server merges this slice and builds
		// the result from its own authoritative state. overallNote is a one-time instruction for the
		// whole review; the server reads it off the body and never persists it (see /api/send).
		const { sent } = await api<{ sent?: boolean }>('/api/send', {
			method: 'POST',
			body: JSON.stringify({
				...reviewerSlice(requireState()),
				overallNote,
			}),
		})
		if (sent) {
			S.awaitingAgent = true
			toast('Sent to agent')
			return
		}
		toast('Could not send review')
	}
}

function installHelpBindings(): void {
	// Keyboard help overlay + destructive-action confirm dialog (keys.ts owns the dialog state).
	S.helpGroups = helpGroups
	S.confirmYes = confirmYes
	S.confirmNo = confirmNo
	S.walkthroughRows = walkthroughRows
}
