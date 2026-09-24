import { useStoreFields } from '@shared/lib/use-store-version'
import { Icon } from '@shared/ui/icon'

import { chromeCtx } from '../context'

import type { ReactElement } from 'react'

// The guide bar under the top bar (guide-attached desks): overview home, the
// whole-file comment toggle, guide prev/next, and the stale-guide notice.

function FileCommentButton(): ReactElement {
	const { S } = chromeCtx()
	const count = S.openFileCommentCount?.() ?? 0
	return (
		<button
			className={`gb-fc${S.fileComposerOpen ? ' open' : ''}`}
			data-tip="Comment on file (⇧C)"
			onClick={() => S.toggleFileComposer?.()}
		>
			<Icon id="gly-comment" />
			{count > 0 && <span className="gb-fc-count">{count}</span>}
		</button>
	)
}

function NavButton({
	direction,
	disabled,
	onClick,
	ariaLabel,
}: {
	direction: 'prev' | 'next'
	disabled: boolean
	onClick: () => void
	ariaLabel: string
}): ReactElement {
	const tips = { prev: 'Previous file (⇧←)', next: 'Next file (⇧→)' }
	const icons = { prev: 'gly-arrow-left', next: 'gly-arrow-right' }
	return (
		<button
			className="gb-nav"
			onClick={onClick}
			disabled={disabled}
			data-tip={tips[direction]}
			aria-label={ariaLabel}
		>
			<Icon id={icons[direction]} />
		</button>
	)
}

export function GuideBar(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields('state', 'settings', 'overviewOpen', 'fileComposerOpen')
	if (!(S.showGuideBar?.() ?? false)) return <></>
	const stale = S.guideStale?.() ?? false
	return (
		<div className="guidebar">
			<div className="gb-acts">
				<button
					className="gb-home"
					onClick={() => S.openOverview?.()}
					data-tip="Overview (o)"
					aria-label="Open overview"
				>
					<Icon id="gly-home" />
				</button>
				{!S.overviewOpen && (S.fileCommentAvailable?.() ?? false) && (
					<FileCommentButton />
				)}
				<NavButton
					direction="prev"
					disabled={S.guideAtStart?.() ?? false}
					onClick={() => S.guidePrev?.()}
				/>
				<NavButton
					direction="next"
					disabled={S.guideAtLast?.() ?? false}
					onClick={() => S.guideNext?.()}
				/>
			</div>
			{stale && (
				<span
					className="gb-stale"
					title="Guide generated for an earlier diff - regenerate and restart with --guide to refresh"
				>
					<Icon id="gly-warn" />
					Guide Stale
				</span>
			)}
			<span className="gb-fill" />
		</div>
	)
}
