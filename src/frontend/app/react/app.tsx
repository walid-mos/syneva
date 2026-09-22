import { useLayoutEffect } from 'react'

import { DeskCovers } from '@widgets/chrome/react/desk-covers'
import { ConfirmModal, SendModal } from '@widgets/chrome/react/dialog-modals'
import { DiffArea } from '@widgets/chrome/react/diff-area'
import { GuideBar } from '@widgets/chrome/react/guide-bar'
import { SettingsModal } from '@widgets/chrome/react/settings-modal'
import { Sidebar } from '@widgets/chrome/react/sidebar'
import { TopBar } from '@widgets/chrome/react/top-bar'
import { TransientChrome } from '@widgets/chrome/react/transient-chrome'

import { useStoreVersion } from '../../shared/lib/use-store-version'
import { S } from '../store'

import type { ReactElement } from 'react'

// The app shell: the same layout the static page used to carry, now owned by
// React. Body-level layout classes (single/file-mode) stay on <body> - the CSS
// keys on body selectors.
export function App(): ReactElement {
	useStoreVersion()
	// useLayoutEffect: the single/file-mode body classes gate the CSS grid layout, so
	// they must land before first paint or single-file desks flash the tree column.
	useLayoutEffect(() => {
		document.body.classList.toggle(
			'single',
			(S.state?.files.length ?? 0) <= 1,
		)
		document.body.classList.toggle('file-mode', S.state?.mode === 'file')
	})
	const deskClosed = S.deskClosed && !S.isRefreshRequired
	return (
		<div
			className={`app${S.isRefreshRequired ? ' refresh-required' : ''}${deskClosed ? ' desk-closed' : ''}`}
		>
			<TopBar />
			<DeskCovers />
			{!deskClosed && (
				<main className="main">
					<Sidebar />
					{/* Narrow-width only (CSS-gated): dims the diff behind the open file drawer; tap to close. */}
					<div
						className={`tree-backdrop${S.treeDrawerOpen ? ' open' : ''}`}
						onClick={() => {
							S.treeDrawerOpen = false
						}}
					/>
					<div className="resizer" data-resize="left" />
					<section className="center">
						<GuideBar />
						<DiffArea />
					</section>
				</main>
			)}
			<SettingsModal />
			<ConfirmModal />
			<SendModal />
			<TransientChrome />
		</div>
	)
}
