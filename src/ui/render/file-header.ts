import { getIconForType, SVGSpriteSheet } from '@pierre/diffs'

import { blockersChip } from '../blockers'
import {
	currentFile,
	currentSplittable,
	fileFinished,
	fileObjections,
} from '../changes'
import { cur } from '../contents'
import { approveCurrentFile, resetReview } from '../decisions'
import {
	fileCommentIconButton,
	fileCommentSection,
	fileCommentsEnabled,
} from '../file-comments'
import { currentGuideEntry, hasGuide } from '../guide'
import { movedFrom } from '../renames'
import { S } from '../store'
import { unanchoredStrip } from '../unanchored'

import { isExpandCapped, EXPAND_LINES_MAX, newLines } from './expand-cap'

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

// The whole-file comment trigger, only where a file-level scope adds something over the line
// threads: hidden on guided desks (the guide bar owns it) and on single-file desks (every
// comment already addresses the one file). Explicit-route fallback for unguided multi-file desks.
export function fileCommentButton(): HTMLElement | null {
	if (hasGuide() || !fileCommentsEnabled()) return null
	return fileCommentIconButton()
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
	const fc = fileCommentButton()
	if (fc) row.appendChild(fc)
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
	// The expand view cap (see currentView in render.ts): the setting promises every row, the
	// paint delivers hunks only past the line budget - surface the compromise where it hurts.
	if (
		S.settings.unchangedLines === 'expand' &&
		isExpandCapped(cur.newContents)
	) {
		const capped = document.createElement('span')
		capped.className = 'ghdr-moved'
		capped.title = `Expand view is capped at ${EXPAND_LINES_MAX.toLocaleString()} lines - this file has ${newLines(cur.newContents).toLocaleString()}`
		capped.textContent = 'expand capped'
		row.appendChild(capped)
	}
	const actions = headerActions()
	actions.className = 'ghdr-actions'
	row.appendChild(actions)
	return row
}

// Row 2, when a grouping is attached: the section this file is listed under. It restates the
// Walkthrough heading beside the file itself, so the reviewer never has to look sideways to know
// which domain they're in.
function guideRow(): HTMLElement | null {
	const entry = currentGuideEntry()
	if (!entry) return null
	const guide = document.createElement('div')
	guide.className = 'ghdr-guide'
	const chip = document.createElement('span')
	chip.className = 'ghdr-cat'
	chip.textContent = entry.category
	guide.appendChild(chip)
	return guide
}

function fileHeader(file: FileDiffMetadata): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'ghdr'
	wrap.style.setProperty('--ct-color', ctColor(file.type))
	wrap.appendChild(headerRow(file))
	const guide = guideRow()
	if (guide) wrap.appendChild(guide)
	// Whole-file comments sit above the unanchored strip: a file-header thread reads before the
	// "these lost their line" warning strip underneath it.
	const fc = fileCommentSection()
	if (fc) wrap.appendChild(fc)
	const strip = unanchoredStrip()
	if (strip) wrap.appendChild(strip)
	return wrap
}

// Preview gets its own minimal header: a neutral file icon + path + a read-only tag - no +/- counts,
// change-type icon, or guidance (all of which would mislabel an unchanged file rendered as
// one-sided content). The Approve / Reset actions don't apply to a preview, but a whole-file
// comment does (the same rule the unguided changed-file header follows).
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
	const fc = fileCommentButton()
	if (fc) row.appendChild(fc)
	row.appendChild(openEditorButton())
	const grow = document.createElement('span')
	grow.className = 'ghdr-grow'
	row.appendChild(grow)
	const tag = document.createElement('span')
	tag.className = 'ghdr-readonly'
	tag.textContent = 'Unchanged'
	row.appendChild(tag)
	wrap.appendChild(row)
	const section = fileCommentSection()
	if (section) wrap.appendChild(section)
	return wrap
}

export function createDiffHeader(
	isPreviewing: boolean,
): (file: FileDiffMetadata) => HTMLElement {
	return isPreviewing ? previewHeader : fileHeader
}
