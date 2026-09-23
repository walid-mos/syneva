import { useStoreFields } from '@shared/lib/use-store-version'
import { Icon } from '@shared/ui/icon'

import { chromeCtx } from '../context'

import type { ReactElement } from 'react'

// The dropdown half of the Reset split button (see reset-button.tsx): the narrower and the
// nuclear option. A fixed backdrop catches outside clicks without a document listener.
function ResetMenu(): ReactElement {
	const { S } = chromeCtx()
	const close = (): void => S.setResetMenu?.(false)
	const run = (scope: 'approved' | 'all'): void => {
		close()
		void S.reset?.(scope)
	}
	return (
		<>
			<div className="reset-backdrop" onClick={close} />
			<div className="reset-menu" role="menu">
				<button
					role="menuitem"
					data-tip="Only the signed-off files go back to pending"
					onClick={() => run('approved')}
				>
					<span>Reset approved</span>
					<span className="reset-hint">
						only the signed-off files
					</span>
				</button>
				<button
					role="menuitem"
					className="danger"
					data-tip="Decisions and notes, everything"
					onClick={() => run('all')}
				>
					<span>Reset All</span>
					<span className="reset-hint">review and notes</span>
				</button>
			</div>
		</>
	)
}

// The Reset split button: the labeled part fires the default scope ('review' - decisions
// and sign-offs drop, the notes survive), the caret opens the dropdown with the narrower
// and the nuclear option. Open state lives in the store so the Esc cascade can close it
// (hotkeys-app) and a store bump mid-menu can't strand a closed-over local flag.
export function ResetButton(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields('resetMenuOpen')
	const open = S.resetMenuOpen
	const close = (): void => S.setResetMenu?.(false)
	return (
		<div className="reset-split">
			<button
				className="btn danger"
				data-tip="Reset review - keeps the notes (⇧R)"
				onClick={() => {
					close()
					void S.reset?.('review')
				}}
			>
				Reset Review
			</button>
			<button
				className="btn danger icon reset-caret"
				aria-label="More reset options"
				aria-expanded={open}
				aria-haspopup="menu"
				data-tip="More reset options"
				onClick={() => S.setResetMenu?.(!open)}
			>
				<Icon id="gly-chevron" className={open ? 'caret-up' : ''} />
			</button>
			{open && <ResetMenu />}
		</div>
	)
}
