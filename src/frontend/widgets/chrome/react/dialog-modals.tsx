import { useStoreFields } from '@shared/lib/use-store-version'

import { chromeCtx } from '../context'

import type { ReactElement } from 'react'

// The confirm dialog (destructive shortcuts route through askConfirm) and the
// Send modal (⇧S receipt + overall note). Visibility flags are store state; the
// buttons and the Enter/Esc hotkeys resolve through the same store methods.
export function ConfirmModal(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields('confirmMsg')
	if (!S.confirmMsg) return null
	return (
		<div
			className="modal-backdrop show"
			onClick={event => {
				if (event.target === event.currentTarget) S.confirmNo?.()
			}}
		>
			<div className="modal confirm" role="dialog" aria-modal="true" aria-label="Confirm action">
				<p>{S.confirmMsg}</p>
				<div className="modal-actions">
					<button className="btn" onClick={() => S.confirmNo?.()}>
						Cancel <kbd>Esc</kbd>
					</button>
					<button
						className="btn primary"
						onClick={() => S.confirmYes?.()}
					>
						Confirm <kbd>↵</kbd>
					</button>
				</div>
			</div>
		</div>
	)
}

export function SendModal(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields('sendOpen', 'sendMsg', 'sendNote')
	if (!S.sendOpen) return null
	return (
		<div
			className="modal-backdrop show"
			onClick={event => {
				if (event.target === event.currentTarget) S.sendCancel?.()
			}}
		>
			<div className="modal send" role="dialog" aria-modal="true" aria-label="Send review to agent">
				<p>{S.sendMsg}</p>
				<textarea
					id="sendNote"
					value={S.sendNote}
					placeholder={
						'Overall note (optional) \u2014 an overall remark, or what to do after applying'
					}
					onChange={event => {
						S.sendNote = event.target.value
					}}
				/>
				<div className="modal-actions">
					<button className="btn" onClick={() => S.sendCancel?.()}>
						Cancel <kbd>Esc</kbd>
					</button>
					<button
						className="btn primary"
						onClick={() => S.sendConfirm?.()}
					>
						Send <kbd>⌘↵</kbd>
					</button>
				</div>
			</div>
		</div>
	)
}
