import { helpGroups } from '@app/keys'
import { isCurrentDesk } from '@app/poll'
import { saver, S } from '@app/store'
import { resetReview, shutdownDesk } from '@entities/review/api'
import { walkthroughRows } from '@entities/review/guide/guide'

import type { GuideInputs } from '@entities/review/guide/guide'

// The guide derivations' explicit inputs, read from the store at each evaluation.
const GI = (): GuideInputs => ({
	state: S.state,
	fileIndex: S.fileIndex,
	hideReviewed: S.settings.hideReviewed,
	progressBy: S.settings.progressBy,
	foldExpanded: S.foldExpanded,
})
import { sendReviewToAgent } from '@features/send-review/send'
import { $ } from '@shared/lib/dom'
import { render } from '@shared/lib/render-scheduler'
import { reviewStats } from '@widgets/chrome/progress'
import {
	askConfirm,
	bindConfirm,
	confirmNo,
	confirmYes,
} from '@widgets/dialogs/confirm'
import { D } from '@widgets/diff-view/runtime'

import { toast } from '../store'

// The modal bindings: the Send receipt (a glance at what is about to go, one-way), the
// review-complete prompt, Reset, the browser Close, and the keyboard-help + confirm dialogs.

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
	// The confirm widget's single store writer, bound at composition (see confirm.ts).
	bindConfirm(message => {
		S.confirmMsg = message
	})
	installSendBindings()
	installCloseBinding()
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
		const body = await resetReview()
		if (!isCurrentDesk(body.serverInstanceId)) return
		S.state = body.state
		D.fileDiff = null
		void render()
		toast('Reset review')
	}
	installSendAction()
}

// How many ms a Close click may wait for the coalescing saver to drain, and how long until
// window.close() fires after the desk ACKed the shutdown.
const CLOSE_SAVE_FLUSH_MS = 800
const CLOSE_WINDOW_DELAY_MS = 250

// The browser Close: the human ends the whole desk, not just the round. The server tells any
// parked agent listener ({kind:"closed"}) before exiting, so this is `syneva stop` with its
// proper paperwork. State is saved continuously; nothing else to hand over.
function installCloseBinding(): void {
	// Confirm-first: one click loses the workspace, so the header button routes through the
	// same destructive-action dialog the ⇧Q hotkey uses.
	S.confirmClose = () => {
		askConfirm(
			'Close the desk? Syneva stops; the review state is saved and the agent is told the review ended.',
			() => void S.closeDesk?.(),
		)
	}
	S.closeDesk = async () => {
		// A trailing save may still carry a not-yet-persisted decision: flush it first so Close
		// can't drop the freshest review mutations (bounded - a wedged desk must still close).
		await saver.drain(CLOSE_SAVE_FLUSH_MS)
		// Paint the cover first: the desk dies within the request's grace window, and a refused
		// script-close leaves the cover as the tab's terminal state.
		S.deskClosed = true
		try {
			await shutdownDesk()
		} catch {
			// An unreachable desk is a closed desk as far as this tab is concerned; the
			// poll's miss counter converges on the same state regardless.
		}
		toast('Desk closed')
		// The desk opens its tab via the OS opener, so script-close is usually refused.
		// Harmless where it works, invisible where it doesn't - the cover already shows.
		setTimeout(() => window.close(), CLOSE_WINDOW_DELAY_MS)
	}
}

// The one-way handoff: post only the reviewer-owned slice, never the whole (multi-MB) ReviewState.
function installSendAction(): void {
	S.send = sendReviewToAgent
}

function installHelpBindings(): void {
	// Keyboard help overlay + destructive-action confirm dialog (keys.ts owns the dialog state).
	S.helpGroups = helpGroups
	S.confirmYes = confirmYes
	S.confirmNo = confirmNo
	S.walkthroughRows = () => walkthroughRows(GI())
}
