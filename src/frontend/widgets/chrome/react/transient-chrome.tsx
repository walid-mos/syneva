import { useStoreFields } from '@shared/lib/use-store-version'

import { chromeCtx } from '../context'

import type { ReactElement } from 'react'

// Transient chrome pinned over the workspace: the toast (store-driven text, the
// .show class gates its visibility) and the go-to-line pill (digits typed in the
// diff; the diff's own key handling commits or cancels).
export function TransientChrome(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields('toastMsg', 'golineBuffer')
	return (
		<>
			<div className={`toast${S.toastMsg ? ' show' : ''}`} role="status">
				{S.toastMsg}
			</div>
			<div
				className={`goline${S.golineBuffer ? ' show' : ''}`}
				role="status"
			>
				Go to line&nbsp;<b>{S.golineBuffer}</b>
				<span className="goline-hint">
					<kbd>↵</kbd> Jump · <kbd>esc</kbd> Cancel
				</span>
			</div>
		</>
	)
}
