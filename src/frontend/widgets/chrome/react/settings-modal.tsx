import { useStoreVersion } from '@shared/lib/use-store-version'

import { chromeCtx } from '../context'

import { SettingsPane } from './settings-pane'

import type { ReactElement } from 'react'

// The keyboard-map pane: the grouped binding list the help overlay renders (fed by
// the keys dispatcher's helpGroups()).
function ShortcutsPane(): ReactElement {
	const { S } = chromeCtx()
	const groups = S.helpGroups?.() ?? []
	return (
		<div className="set-pane help-grid">
			{groups.map(grp => (
				<div className="help-col" key={grp.group}>
					<div className="help-h">{grp.group}</div>
					{grp.items.map(binding => (
						<div className="help-row" key={binding.combo}>
							<kbd>{binding.combo}</kbd>
							<span>{binding.desc}</span>
						</div>
					))}
				</div>
			))}
		</div>
	)
}

// The settings modal: preferences and the keyboard map behind two tabs. Every
// control writes through the store and lands in applySettings() - the same
// persist + appearance + funnel path as before.
export function SettingsModal(): ReactElement {
	const { S } = chromeCtx()
	useStoreVersion()
	if (!S.settingsOpen) return <></>
	return (
		<div
			className="modal-backdrop show"
			onClick={event => {
				if (event.target === event.currentTarget) S.closeSettings?.()
			}}
		>
			<div className="modal settings" role="dialog" aria-modal="true" aria-label="Settings">
				<div className="set-tabs" role="tablist">
					<button
						className={S.settingsTab === 'settings' ? 'active' : ''}
						aria-selected={S.settingsTab === 'settings'}
						onClick={() => {
							S.settingsTab = 'settings'
						}}
					>
						Settings
					</button>
					<button
						className={
							S.settingsTab === 'shortcuts' ? 'active' : ''
						}
						onClick={() => {
							S.settingsTab = 'shortcuts'
						}}
					>
						Shortcuts
					</button>
				</div>
				{S.settingsTab === 'settings' ? (
					<SettingsPane />
				) : (
					<ShortcutsPane />
				)}
				<div className="modal-actions">
					<button
						className="btn primary"
						onClick={() => S.closeSettings?.()}
					>
						Done
					</button>
				</div>
			</div>
		</div>
	)
}
