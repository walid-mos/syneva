// Stage a destructive action behind the confirm dialog: whoever asks records what Enter should do,
// and the dialog's buttons (or the Enter/Esc hotkeys) resolve it. One pending action at a time -
// a second ask replaces the first, exactly like the single visible dialog.
//
// The dialog's visibility flag is store state, but this widget never imports the app store:
// app composition binds the one writer below (facade/dialogs.ts), keeping the widgets layer
// free of @app imports.
let setConfirmMsg: (message: string) => void

export function bindConfirm(writer: (message: string) => void): void {
	setConfirmMsg = writer
}

let pending: (() => void) | null = null

export function askConfirm(message: string, run: () => void): void {
	setConfirmMsg(message)
	pending = run
}

export function confirmYes(): void {
	const run = pending
	setConfirmMsg('')
	pending = null
	run?.()
}

export function confirmNo(): void {
	setConfirmMsg('')
	pending = null
}
