import { getIconForType, SVGSpriteSheet } from '@pierre/diffs'

import { blockersChip } from '../blockers'
import {
	currentFile,
	currentSplittable,
	fileFinished,
	fileObjections,
} from '../changes'
import { buildCommentThread } from '../comment-thread'
import { approveCurrentFile, resetReview } from '../decisions'
import { currentGuideEntry } from '../guide'
import { renderMarkdown } from '../markdown'
import {
	isFileSkim,
	isFileSkimCollapsed,
	movedFrom,
	toggleFileSkim,
} from '../skim'
import { S } from '../store'
import { unanchoredThreads } from '../unanchored'

import type { ChangeTypes, FileDiffMetadata } from '@pierre/diffs'

// The custom diff header (all changed-file modes). Row 1 preserves @pierre's look - change-type
// icon + filename + a subtle Split/Stacked toggle + counts + actions. With a guide, row 2
// (left-aligned) adds the category + AI guidance. A preview (an unchanged file the reviewer
// opened to read) gets a minimal read-only header instead.

const SVG_NS = 'http://www.w3.org/2000/svg'
// Header icon size, matching @pierre's own inline icons.
const HEADER_ICON_SIZE = 16

// @pierre mounts its icon sprite into each diff's shadow root, so a light-DOM `<use>` can't reach
// it. Inject the same sprite into the document once so our custom header can reuse @pierre's exact
// change-type icons.
let isSpriteInjected = false

function ensureSprite(): void {
	if (isSpriteInjected) return
	const holder = document.createElement('div')
	holder.innerHTML = SVGSpriteSheet
	const svg = holder.firstElementChild
	if (svg) document.body.appendChild(svg)
	isSpriteInjected = true
}

// Change-type accent color, shared by the header icon and the guidance blockquote line. Keyed by
// the full union so a new change type has to name its color.
const CHANGE_COLORS: Record<ChangeTypes | 'file', string> = {
	new: 'var(--green)',
	change: 'var(--cyan)',
	deleted: 'var(--red)',
	'rename-pure': 'var(--amber)',
	'rename-changed': 'var(--amber)',
	file: 'var(--muted)',
}

function ctColor(type: ChangeTypes | 'file' | undefined): string {
	return type ? CHANGE_COLORS[type] : CHANGE_COLORS.file
}

// @pierre's change-type icon as light-DOM SVG (the lib's createIconElement returns HAST).
function changeIcon(type: ChangeTypes | 'file' | undefined): SVGElement {
	ensureSprite()
	const t: ChangeTypes | 'file' = type ?? 'file'
	const svg = document.createElementNS(SVG_NS, 'svg')
	svg.setAttribute('width', String(HEADER_ICON_SIZE))
	svg.setAttribute('height', String(HEADER_ICON_SIZE))
	svg.setAttribute('viewBox', `0 0 ${HEADER_ICON_SIZE} ${HEADER_ICON_SIZE}`)
	svg.setAttribute('class', 'ghdr-icon')
	svg.setAttribute('data-change-icon', t)
	const use = document.createElementNS(SVG_NS, 'use')
	use.setAttribute('href', `#${getIconForType(t)}`)
	svg.appendChild(use)
	return svg
}

// Subtle Split/Stacked segmented control that lives in the diff header (right of the filename).
// Kept low-contrast so it doesn't compete with the filename; clicking re-renders the diff,
// which rebuilds this control with the new active state.
function layoutToggle(): HTMLElement {
	const wrap = document.createElement('span')
	wrap.className = 'ghdr-layout'
	wrap.setAttribute('data-tip', 'Split / Stacked (v)')
	const mk = (label: string, style: 'split' | 'unified'): void => {
		const b = document.createElement('button')
		b.textContent = label
		if (S.diffStyle === style) b.className = 'active'
		b.addEventListener('click', () => S.setStyle?.(style))
		wrap.appendChild(b)
	}
	mk('Split', 'split')
	mk('Stacked', 'unified')
	return wrap
}

// Icon-only "jump to this file in the local editor" button - file-scoped, so it lives in
// the file header rather than the app chrome (the top bar is for review-final actions).
function openEditorButton(): HTMLElement {
	const b = document.createElement('button')
	b.className = 'ghdr-open'
	b.setAttribute('data-tip', 'Open in editor (⇧E)')
	b.innerHTML = `<svg class="ic"><use href="#gly-open-editor"></use></svg>`
	b.addEventListener('click', () => void S.openInEditor?.())
	return b
}

// The per-file sign-off action in the diff header. Unfinished -> one context button:
// "Approve" (clean) or "Mark reviewed" (has a rejected hunk / open requested-change), which
// accepts pending hunks, signs off, and advances. Finished -> a state pill + Reset to undo.
export function headerActions(): HTMLElement {
	const wrap = document.createElement('span')
	const filePath = currentFile().path
	const reset = (): HTMLElement => {
		const b = document.createElement('button')
		b.className = 'diff-header-action undo'
		b.textContent = 'Reset'
		b.addEventListener('click', () => void resetReview(filePath))
		return b
	}
	// The chip lists what keeps the file from Approved (rejected hunks, open change
	// requests) with jump-to actions - rendered whenever objections exist, finished or not.
	const chip = blockersChip()
	// A skim-flagged file that's been expanded gets a quiet re-collapse control (the counterpart
	// to the collapsed strip's Expand), so the reviewer can fold it back after a look.
	if (isFileSkim(filePath) && !isFileSkimCollapsed(filePath)) {
		const collapse = document.createElement('button')
		collapse.className = 'diff-header-action skim-collapse'
		collapse.textContent = 'Collapse'
		collapse.title = 'Collapse this skimmed file'
		collapse.addEventListener('click', () => toggleFileSkim(filePath))
		wrap.appendChild(collapse)
	}
	if (fileFinished(filePath)) {
		// The file-tree badge carries the approved / changes-requested state; the header just
		// offers a quiet Reset to undo the sign-off (plus the blockers chip when relevant).
		if (chip) wrap.appendChild(chip)
		wrap.appendChild(reset())
	} else {
		const objections = fileObjections(filePath)
		// Reset (clear in-progress hunk decisions) sits on the left; Approve is always far right.
		if (S.state?.decisionFiles?.includes(filePath))
			wrap.appendChild(reset())
		if (chip) wrap.appendChild(chip)
		const button = document.createElement('button')
		button.className = `diff-header-action${objections ? ' warn' : ''}`
		button.innerHTML = `${objections ? 'Mark Reviewed' : 'Approve'} <kbd>⇧A</kbd>`
		button.addEventListener('click', () => void approveCurrentFile())
		wrap.appendChild(button)
	}
	return wrap
}

// The unanchored-comment strip: open threads whose anchor line no longer renders, shown as the
// diff's first row so they stay actionable (they block approval until resolved).
function unanchoredStrip(): HTMLElement | null {
	const orphans = unanchoredThreads()
	if (!orphans.length) return null
	const strip = document.createElement('div')
	strip.className = 'unanchored-strip'
	const head = document.createElement('div')
	head.className = 'unanchored-head'
	const noun = orphans.length === 1 ? 'thread' : 'threads'
	const pronoun = orphans.length === 1 ? 'its' : 'their'
	head.textContent = `${orphans.length} comment ${noun} lost ${pronoun} place in this diff - resolve or reply here`
	strip.appendChild(head)
	for (const thread of orphans) {
		// Reuse the annotation thread styling (it's all scoped under .annotation).
		const box = document.createElement('div')
		box.className = 'annotation'
		box.dataset.thread = `${thread.side}:${thread.lineNumber}` // blockers jump target
		box.appendChild(buildCommentThread(thread))
		strip.appendChild(box)
	}
	return strip
}

// Row 1 of a changed file's header: icon, path, rename note, layout toggle, editor button, the
// +/- counts and the file's actions.
function headerRow(file: FileDiffMetadata): HTMLElement {
	const row = document.createElement('div')
	row.className = 'ghdr-row1'
	row.appendChild(changeIcon(file.type))
	const name = document.createElement('span')
	name.className = 'ghdr-file'
	name.textContent = currentFile().path
	row.appendChild(name)
	// Rename+edit files (git -M): note where the file moved from, right of the new path.
	const from = movedFrom(currentFile().path)
	if (from) {
		const moved = document.createElement('span')
		moved.className = 'ghdr-moved'
		moved.title = `moved from ${from}`
		moved.textContent = `moved from ${from}`
		row.appendChild(moved)
	}
	// Layout toggle right of the filename - only when Split actually applies (a two-sided diff).
	if (currentSplittable()) row.appendChild(layoutToggle())
	row.appendChild(openEditorButton())
	const grow = document.createElement('span')
	grow.className = 'ghdr-grow'
	row.appendChild(grow)
	let added = 0
	let deleted = 0
	for (const hunk of file.hunks) {
		added += hunk.additionLines
		deleted += hunk.deletionLines
	}
	const counts = document.createElement('span')
	counts.className = 'ghdr-counts'
	counts.innerHTML = `<span class="a">+${added}</span><span class="d">-${deleted}</span>`
	row.appendChild(counts)
	const actions = headerActions()
	actions.className = 'ghdr-actions'
	row.appendChild(actions)
	return row
}

// Row 2, when a guide is attached: the category chip and the agent's guidance for this file. The
// prose fields render as markdown (renderMarkdown sanitizes) - the guidance is the main reading
// content of a guided review, so identifiers/lists the agent writes survive.
function guideRow(): HTMLElement | null {
	const entry = currentGuideEntry()
	if (!entry) return null
	const guide = document.createElement('div')
	guide.className = 'ghdr-guide'
	const chip = document.createElement('span')
	chip.className = `ghdr-cat${entry.flag ? ' crit' : ''}`
	chip.textContent = entry.category
	guide.appendChild(chip)
	const explanation = document.createElement('div')
	explanation.className = 'ghdr-expl md'
	explanation.innerHTML = renderMarkdown(entry.orientation)
	guide.appendChild(explanation)
	// A flagged file gets its own readable callout within the card.
	if (entry.flag) {
		const flag = document.createElement('div')
		flag.className = 'ghdr-flag'
		flag.innerHTML = `<svg class="ic"><use href="#gly-flag"></use></svg><div class="md">${renderMarkdown(entry.flag)}</div>`
		guide.appendChild(flag)
	}
	return guide
}

function fileHeader(file: FileDiffMetadata): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'ghdr'
	wrap.style.setProperty('--ct-color', ctColor(file.type))
	wrap.appendChild(headerRow(file))
	const guide = guideRow()
	if (guide) wrap.appendChild(guide)
	const strip = unanchoredStrip()
	if (strip) wrap.appendChild(strip)
	return wrap
}

// Preview gets its own minimal header: a neutral file icon + path + a read-only tag - no +/- counts,
// change-type icon, or guidance (all of which would mislabel an unchanged file rendered as
// one-sided content). The Approve / Reset actions don't apply to a preview.
function previewHeader(): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'ghdr'
	const row = document.createElement('div')
	row.className = 'ghdr-row1'
	row.appendChild(changeIcon('file'))
	const name = document.createElement('span')
	name.className = 'ghdr-file'
	name.textContent = currentFile().path
	row.appendChild(name)
	row.appendChild(openEditorButton())
	const grow = document.createElement('span')
	grow.className = 'ghdr-grow'
	row.appendChild(grow)
	const tag = document.createElement('span')
	tag.className = 'ghdr-readonly'
	tag.textContent = 'Unchanged'
	row.appendChild(tag)
	wrap.appendChild(row)
	return wrap
}

export function createDiffHeader(
	isPreviewing: boolean,
): (file: FileDiffMetadata) => HTMLElement {
	return isPreviewing ? previewHeader : fileHeader
}
