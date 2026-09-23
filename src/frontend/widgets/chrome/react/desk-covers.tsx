import { useStoreFields } from '@shared/lib/use-store-version'

import { chromeCtx } from '../context'

import type { ReactElement } from 'react'

// Full-surface status layers: the refresh notice (a restarted desk may require a
// different UI bundle) and the desk-closed cover (one-way for the tab; polling
// continues so a same-origin restart can propose the refresh above).
export function DeskCovers(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields('state', 'deskClosed', 'isRefreshRequired')
	return (
		<>
			{S.isRefreshRequired && (
				<div className="refresh-notice" role="status">
					<strong>Desk restarted.</strong> Finish pending actions and
					copy any unsaved text, then refresh this tab to reconnect.
				</div>
			)}
			{S.deskClosed && !S.isRefreshRequired && (
				<div className="desk-closed-cover" role="status">
					<div className="desk-closed-card">
						<strong>Desk closed.</strong>
						<p>
							The Syneva desk stopped. All review state is saved
							on disk; the attached agent was told the review
							ended.
						</p>
						<p>
							Reopen it in the repo with{' '}
							<code>{`syneva --session ${S.state ? S.state.session : ''}`}</code>
							.
						</p>
					</div>
				</div>
			)}
		</>
	)
}
