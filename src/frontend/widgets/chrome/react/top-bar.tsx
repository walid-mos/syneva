import { useEffect, useRef, useState } from 'react'

import { guideProgress } from '@entities/review/guide/guide'
import { useStoreVersion } from '@shared/lib/use-store-version'
import { Icon } from '@shared/ui/icon'

import { chromeCtx } from '../context'

import { BrandBlock } from './brand-logo'

import type { GuideInputs } from '@entities/review/guide/guide'
import type { ReactElement } from 'react'

// The top bar: brand, lenses, agent status, progress, and the desk-level actions.
// The *moment* of progress is animated (count-up label, pulse strip), which is rAF
// work on top of the store-version subscription.

// Persistent review-progress chrome: a full-width fill strip along the bottom edge of
// the topbar plus a "% reviewed" label beside the actions.
const COUNT_UP_MS = 450
const EASE_POWER = 3
const FULL_PERCENT = 100

// Tab title carries progress too ("(58%) Syneva - repo"), so it reads from other tabs.
// main.ts names the base title at init; setBaseTitle stamps the prefix.
let baseTitle = document.title
export function setBaseTitle(title: string): void {
	baseTitle = title
}

function titleFor(pct: number): string {
	if (pct >= FULL_PERCENT) return `✓ ${baseTitle}`
	if (pct > 0) return `(${pct}%) ${baseTitle}`
	return baseTitle
}

function guideInputs(S: ReturnType<typeof chromeCtx>['S']): GuideInputs {
	return {
		state: S.state,
		fileIndex: S.fileIndex,
		hideReviewed: S.settings.hideReviewed,
		progressBy: S.settings.progressBy,
		foldExpanded: S.foldExpanded,
	}
}

// The animated "% reviewed" pair (strip + label). One component owns both, exactly
// like the old imperative writer owned both elements.
function ReviewProgress(): ReactElement {
	const { S } = chromeCtx()
	useStoreVersion()
	const hasFiles = Boolean(S.state?.files.length)
	const pct = hasFiles ? guideProgress(guideInputs(S)).pct : 0

	// Count the label from the previous value to the new one over ~450ms
	// (ease-out) instead of jumping; no movement means no ceremony.
	const shownRef = useRef<number | null>(null)
	const [labelPct, setLabelPct] = useState<number>(pct)
	const stripRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		document.title = hasFiles ? titleFor(pct) : baseTitle
		if (!hasFiles) return undefined
		const shown = shownRef.current
		if (shown === null || pct === shown) {
			setLabelPct(pct)
			shownRef.current = pct
			return undefined
		}
		if (pct > shown && stripRef.current) {
			// Restart the .pulse CSS animation even when the class is already on.
			const strip = stripRef.current
			strip.classList.remove('pulse')
			void strip.offsetWidth
			strip.classList.add('pulse')
		}
		const from = shown
		const start = performance.now()
		let raf = 0
		const tick = (now: number): void => {
			const k = Math.min(1, (now - start) / COUNT_UP_MS)
			const eased = 1 - (1 - k) ** EASE_POWER
			setLabelPct(Math.round(from + (pct - from) * eased))
			if (k < 1) raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		shownRef.current = pct
		return () => cancelAnimationFrame(raf)
	}, [pct, hasFiles])

	if (!hasFiles) return <></>
	return (
		<>
			<span className="top-pct">{labelPct}% reviewed</span>
			<div className="top-progress" ref={stripRef}>
				<i style={{ width: `${pct}%` }} />
			</div>
		</>
	)
}

// The view lenses: hide-reviewed (multi-round reviews) and the markdown
// rendered/source pair - each only when it applies to the current file.
function TopToggles(): ReactElement {
	const { S } = chromeCtx()
	return (
		<div className="toggles">
			{S.hasReviewed?.() && (
				<div className="toggle" data-tip="Hide accepted changes (⇧H)">
					<button
						className={S.settings.hideReviewed ? 'active' : ''}
						onClick={() => S.toggleHideReviewed?.()}
					>
						Hide approved<kbd>⇧H</kbd>
					</button>
				</div>
			)}
			{S.isMarkdownFile?.() && (
				<div className="toggle" data-tip="Rendered / source (m)">
					<button
						className={S.fileView === 'rendered' ? 'active' : ''}
						onClick={() => S.setFileView?.('rendered')}
					>
						Rendered
					</button>
					<button
						className={S.fileView === 'source' ? 'active' : ''}
						onClick={() => S.setFileView?.('source')}
					>
						Source
					</button>
				</div>
			)}
		</div>
	)
}

function AgentStatus(): ReactElement {
	const { S } = chromeCtx()
	const visible =
		S.awaitingAgent && (S.queuedReviews > 0 || Boolean(S.agentActivity))
	if (!visible) return <></>
	const text =
		S.queuedReviews > 0
			? 'No agent attached \u2014 review queued'
			: (S.agentActivity ?? '')
	return (
		<span className={`agent-status${S.queuedReviews > 0 ? ' queued' : ''}`}>
			{text}
		</span>
	)
}

// The desk-level actions: settings, reset, send, close. Each is a store method
// call - the confirm gates live behind the facade methods.
function DeskButtons(): ReactElement {
	const { S } = chromeCtx()
	return (
		<>
			<button
				className="btn icon top-settings"
				data-tip="Settings (⇧,)"
				onClick={() => S.openSettings?.()}
			>
				<Icon id="gly-settings" />
			</button>
			<button
				className="btn danger"
				data-tip="Reset review (⇧R)"
				onClick={() => void S.reset?.()}
			>
				Reset Review
			</button>
			<button
				className="btn primary"
				disabled={S.awaitingAgent}
				onClick={() => S.confirmSend?.()}
			>
				<span>
					{S.awaitingAgent ? 'Waiting for Agent…' : 'Send to Agent'}
				</span>
				<kbd>⇧S</kbd>
			</button>
			<button
				className="btn danger"
				data-tip="Close Syneva - stop the desk (⇧Q)"
				onClick={() => void S.closeDesk?.()}
			>
				Close
			</button>
		</>
	)
}

function TopActions(): ReactElement {
	return (
		<div className="actions">
			<AgentStatus />
			<ReviewProgress />
			<DeskButtons />
		</div>
	)
}

export function TopBar(): ReactElement {
	return (
		<header className="top">
			<BrandBlock />
			<TopToggles />
			<TopActions />
		</header>
	)
}
