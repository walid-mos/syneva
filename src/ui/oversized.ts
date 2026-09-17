import {
	currentFile,
	currentFileOrNull,
	fileFinished,
	fileObjections,
	fileReviewState,
} from './changes'
import { approveCurrentFile, resetReview, rejectFile } from './decisions'
import {
	fileCommentIconButton,
	fileCommentSection,
	fileCommentsEnabled,
} from './file-comments'
import { currentGuideEntry, hasGuide } from './guide'
import { movedFrom } from './renames'
import { deferRender } from './render'
import { S, $, esc } from './store'

import type { ReviewState } from './types'

type ReviewFile = ReviewState['files'][number]
type GuideEntry = ReturnType<typeof currentGuideEntry>

const BYTES_PER_UNIT = 1024

// ── Oversized-file placeholder card (issue 05) ───────────────────────────────
// A file whose diff would freeze the tab (server-stamped `oversized`, see state.ts) renders as a
// verdict-capable summary card INSTEAD of fetching + rendering its diff - so opening it never
// blocks on a multi-MB tokenization pass. The card carries the file's stats, its guide badges, the
// same whole-file verdict controls a rendered file has, and a "Load diff anyway" escape hatch. Once
// loaded, the file behaves like any rendered file for the rest of the session (S.loadedOversized).

// Whether `f` (default: the current file) should paint the placeholder card right now: it's stamped
// oversized and the reviewer hasn't chosen to load its real diff this session.
export function isOversizedPlaceholder(f: ReviewFile = currentFile()): boolean {
	return !!f.oversized && !S.loadedOversized.has(f.path)
}

// "Load diff anyway": remember the choice and re-render. render() now falls through the placeholder
// branch to the normal diff path, which fetches contents via the existing per-file endpoint and
// shows the large-file "Rendering…" indicator (deferRender(true) forces it for any big file).
export function loadOversizedDiff(): void {
	const file = currentFileOrNull()
	if (!file) return
	S.loadedOversized.add(file.path)
	deferRender(true)
}

// Human-readable byte size (the card's focal stat - the file is large). Binary units, one decimal
// past KB so a 1.4 MB file doesn't round to "1 MB".
function formatBytes(n: number): string {
	if (n < BYTES_PER_UNIT) return `${n} B`
	const units = ['KB', 'MB', 'GB']
	let v = n / BYTES_PER_UNIT
	let i = 0
	while (v >= BYTES_PER_UNIT && i < units.length - 1) {
		v /= BYTES_PER_UNIT
		i++
	}
	return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

// Change-kind → the accent color language the diff header uses (ctColor in render.ts).
function kindClass(kind: ReviewFile['changeKind']): string {
	if (kind === 'added') return 'new'
	if (kind === 'deleted') return 'deleted'
	if (kind === 'renamed') return 'renamed'
	return 'modified'
}

// The whole-file verdict controls - identical semantics to a rendered file's header:
// finished → a state pill + Reset; otherwise Reject file (when there are blocks to reject) +
// Approve / Mark Reviewed.
function verdictControls(path: string): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'ovsz-verdict'
	if (fileFinished(path)) {
		const state = fileReviewState(path)
		const pill = document.createElement('span')
		pill.className = `ovsz-pill ${state === 'approved' ? 'ok' : 'warn'}`
		pill.textContent =
			state === 'approved' ? 'Approved' : 'Changes requested'
		wrap.appendChild(pill)
		const reset = document.createElement('button')
		reset.className = 'ovsz-btn ghost'
		reset.textContent = 'Reset'
		reset.addEventListener('click', () => void resetReview(path))
		wrap.appendChild(reset)
		return wrap
	}
	// Reject file only makes sense when the file actually has change blocks (a hunk-less added file
	// has none - nothing to reject block-by-block).
	const hasBlocks = (S.state?.changes ?? []).some(c => c.path === path)
	if (hasBlocks) {
		const reject = document.createElement('button')
		reject.className = 'ovsz-btn danger'
		reject.textContent = 'Reject file'
		reject.addEventListener('click', () => void rejectFile(path))
		wrap.appendChild(reject)
	}
	const objections = fileObjections(path)
	const approve = document.createElement('button')
	approve.className = `ovsz-btn primary${objections ? ' warn' : ''}`
	approve.innerHTML = `${objections ? 'Mark Reviewed' : 'Approve'} <kbd>⇧A</kbd>`
	approve.addEventListener('click', () => void approveCurrentFile())
	wrap.appendChild(approve)
	return wrap
}

// Row 1: change-type icon + path (+ rename arrow) + a kind badge (+ the whole-file comment
// trigger on unguided desks - the guide bar owns it otherwise).
function headSection(file: ReviewFile): HTMLElement {
	const head = document.createElement('div')
	head.className = 'ovsz-head'
	head.innerHTML = `<svg class="ovsz-icon ic"><use href="#gly-file"></use></svg>`
	const name = document.createElement('span')
	name.className = 'ovsz-path'
	name.textContent = file.path
	head.appendChild(name)
	const from = movedFrom(file.path)
	if (from) {
		const moved = document.createElement('span')
		moved.className = 'ovsz-moved'
		moved.innerHTML = `<svg class="ic"><use href="#gly-arrow-right"></use></svg><span>from ${esc(from)}</span>`
		head.appendChild(moved)
	}
	const kind = document.createElement('span')
	kind.className = 'ovsz-kind'
	kind.textContent = file.changeKind ?? 'modified'
	head.appendChild(kind)
	// The whole-file comment trigger, UNGUIDED desks only (a guided desk's icon is in the guide
	// bar next to home; and the two surfaces must never show duplicates).
	// Whole-file comment trigger: multi-file unguided desks only (a guided desk's icon is in
	// the guide bar; a single-file desk has no use for the scope).
	if (!hasGuide() && fileCommentsEnabled())
		head.appendChild(fileCommentIconButton())
	return head
}

// The section this file is grouped under, as a chip on the card (the diff header shows the same one).
function badgesSection(entry: GuideEntry): HTMLElement | null {
	if (!entry) return null
	const badges = document.createElement('div')
	badges.className = 'ovsz-badges'
	const cat = document.createElement('span')
	cat.className = 'ovsz-cat'
	cat.textContent = entry.category
	badges.appendChild(cat)
	return badges
}

// Stats: byte size is the focal number (why this is a card), with the churn counts beside it.
function statsSection(file: ReviewFile): HTMLElement {
	const stats = document.createElement('div')
	stats.className = 'ovsz-stats'
	if (typeof file.size === 'number') {
		const size = document.createElement('span')
		size.className = 'ovsz-size'
		size.textContent = formatBytes(file.size)
		stats.appendChild(size)
	}
	const counts = document.createElement('span')
	counts.className = 'ovsz-counts'
	counts.innerHTML = `<span class="a">+${file.added}</span><span class="d">-${file.removed}</span>`
	stats.appendChild(counts)
	return stats
}

function actionsSection(path: string): HTMLElement {
	const actions = document.createElement('div')
	actions.className = 'ovsz-actions'
	actions.appendChild(verdictControls(path))
	const load = document.createElement('button')
	load.className = 'ovsz-load'
	load.innerHTML = `Load diff anyway <kbd>↵</kbd>`
	load.addEventListener('click', () => loadOversizedDiff())
	actions.appendChild(load)
	return actions
}

// Render the summary card into #diff. Called from renderCenter in place of the diff, BEFORE any
// contents fetch - so an oversized file costs nothing to open.
export function renderOversizedCard(): void {
	const file = currentFile()
	const entry = currentGuideEntry()
	const card = document.createElement('div')
	card.className = `oversized-card ct-${kindClass(file.changeKind)}`
	card.appendChild(headSection(file))
	const badges = badgesSection(entry)
	if (badges) card.appendChild(badges)
	card.appendChild(statsSection(file))
	const note = document.createElement('p')
	note.className = 'ovsz-note'
	note.textContent =
		'This file is large. Its diff is hidden to keep the desk responsive.'
	card.appendChild(note)
	// The oversized card is the file's whole verdict surface - a whole-file comment naturally
	// lives here too (its thread renders inside the card like any file header section).
	const fc = fileCommentSection()
	if (fc) card.appendChild(fc)
	card.appendChild(actionsSection(file.path))
	$('diff').replaceChildren(card)
}
