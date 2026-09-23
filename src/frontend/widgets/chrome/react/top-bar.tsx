import { useEffect, useRef, useState } from 'react'

import { guideProgress } from '@entities/review/guide/guide'
import { reviewNotes } from '@entities/review/notes'
import { useStoreFields } from '@shared/lib/use-store-version'
import { Icon } from '@shared/ui/icon'

import { chromeCtx } from '../context'

import { BrandBlock } from './brand-logo'
import { ResetButton } from './reset-button'

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
// The count-up animation: the label eases from the previous % to the new one over
// ~450ms (ease-out) instead of jumping, and the strip pulses when the bar advances.
// Extracted from the component so the render stays at one level of abstraction.
function animateCountUp(
	from: number,
	to: number,
	show: (pct: number) => void,
): () => void {
	const start = performance.now()
	let raf = 0
	const tick = (now: number): void => {
		const k = Math.min(1, (now - start) / COUNT_UP_MS)
		const eased = 1 - (1 - k) ** EASE_POWER
		show(Math.round(from + (to - from) * eased))
		if (k < 1) raf = requestAnimationFrame(tick)
	}
	raf = requestAnimationFrame(tick)
	return () => cancelAnimationFrame(raf)
}

function restartPulse(strip: HTMLElement): void {
	// Restart the .pulse CSS animation even when the class is already on.
	strip.classList.remove('pulse')
	void strip.offsetWidth
	strip.classList.add('pulse')
}

function ReviewProgress(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields(
		'state',
		'fileIndex',
		'preview',
		'overviewOpen',
		'settings',
		'awaitingAgent',
		'queuedReviews',
		'agentActivity',
		'fileView',
		'treeDrawerOpen',
	)
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
		if (pct > shown && stripRef.current) restartPulse(stripRef.current)
		const cancel = animateCountUp(shown, pct, setLabelPct)
		shownRef.current = pct
		return cancel
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
				<div className="toggle">
					<button
						className={S.settings.hideReviewed ? 'active' : ''}
						aria-pressed={Boolean(S.settings.hideReviewed)}
						data-tip="Hide accepted changes (⇧H)"
						onClick={() => S.toggleHideReviewed?.()}
					>
						Hide approved<kbd>⇧H</kbd>
					</button>
				</div>
			)}
			{S.isMarkdownFile?.() && (
				<div className="toggle">
					<button
						className={S.fileView === 'rendered' ? 'active' : ''}
						aria-pressed={S.fileView === 'rendered'}
						data-tip="Rendered / source (m)"
						onClick={() => S.setFileView?.('rendered')}
					>
						Rendered
					</button>
					<button
						className={S.fileView === 'source' ? 'active' : ''}
						aria-pressed={S.fileView === 'source'}
						data-tip="Rendered / source (m)"
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

// The notes-panel trigger: a plain labeled button (the desk has no icon-only
// habit in this corner) with the open-thread count riding it when there is one.
// Own subscription: the count re-derives off `state` without dragging the other
// desk buttons into every poll.
function NotesButton(): ReactElement {
	const { S } = chromeCtx()
	useStoreFields('state', 'notesOpen')
	const open = reviewNotes(S.state).filter(n => n.status === 'open').length
	return (
		<button
			className={`btn top-notes${S.notesOpen ? ' active' : ''}`}
			data-tip="Review notes - all comments & questions (n)"
			aria-pressed={S.notesOpen}
			onClick={() => S.toggleNotes?.()}
		>
			<span>Notes</span>
			{open > 0 && <span className="notes-count">{open}</span>}
		</button>
	)
}

// The desk-level actions: notes, settings, reset, send, close. Each is a store method
// call - the confirm gates live behind the facade methods.
function DeskButtons(): ReactElement {
	const { S } = chromeCtx()
	return (
		<>
			<NotesButton />
			<button
				className="btn icon top-settings"
				data-tip="Settings (⇧,)"
				aria-label="Open settings"
				onClick={() => S.openSettings?.()}
			>
				<Icon id="gly-settings" />
			</button>
			<ResetButton />
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
