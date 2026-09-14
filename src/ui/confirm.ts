import { S } from './store'

// Stage a destructive action behind the confirm dialog: whoever asks records what Enter should do,
// and the dialog's buttons (or the Enter/Esc hotkeys) resolve it. One pending action at a time -
// a second ask replaces the first, exactly like the single visible dialog.
let pending: (() => void) | null = null

export function askConfirm(message: string, run: () => void): void {
	S.confirmMsg = message
	pending = run
}

export function confirmYes(): void {
	const run = pending
	S.confirmMsg = ''
	pending = null
	run?.()
}

export function confirmNo(): void {
	S.confirmMsg = ''
	pending = null
}
