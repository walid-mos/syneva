import { useStoreFields } from '@shared/lib/use-store-version'

import { chromeCtx } from '../context'

import type { ReactElement } from 'react'

// The diff area's React-owned chrome around the engine island: the Rendering…
// badge shown while a (non-cached) diff render is in flight, and the floating
// Approve / Mark Reviewed button revealed once the diff is scrolled past its
// header. #diff and #ovr stay engine-owned plain divs - the engine mounts into
// them (the React tree never touches their children).
export function DiffArea(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields(
		'state',
		'fileIndex',
		'preview',
		'overviewOpen',
		'settings',
		'rendering',
		'diffScrolled',
	)
	const fab = S.diffScrolled ? (S.fabState?.() ?? null) : null
	return (
		<div className="diff-area">
			<div id="diff" />
			<div className="ovr" id="ovr" />
			{S.rendering && (
				<div className="diff-rendering">
					<span>Rendering…</span>
				</div>
			)}
			{fab && (
				<button
					className={`diff-fab${fab === 'changes' ? ' warn' : ''}`}
					onClick={() => S.approveFile?.()}
				>
					<span>
						{fab === 'changes' ? 'Mark Reviewed' : 'Approve'}
					</span>
					<kbd>⇧A</kbd>
				</button>
			)}
		</div>
	)
}
