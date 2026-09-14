import { currentChanges, currentFile } from './changes'
import { diffShadowRoot } from './diff-dom'
import { render } from './render'
import { isFullySkimmed } from './skim-derive'
import { S, $, esc, toast } from './store'

import type { ChangeState, GuideFile } from './types'

// ── Skimmable review (issue 06) ──────────────────────────────────────────────
// The agent's guide can mark a whole file (GuideFile.skim) or specific change blocks
// (resolveSkim stamps ChangeState.skim on the server) as skimmable for a focused review.
// The desk collapses them by default but never removes them - display only, decisions
// untouched. Expanded/collapsed state is per-session (S.skimExpanded), never persisted.
//
// The block-collapse row hiding is imperative (applySkimCollapse) because @pierre exposes
// no primitive to fold a change block: its `collapsed` option is whole-file, expandHunk is
// for unchanged context, and annotations only ADD rows. A CSS-only hide was probed and
// rejected - split view pairs the two `<code>` columns through unlabeled, variable-count
// filler rows reachable only by grid position (a top-of-file block has no cell to anchor a
// sibling selector, and a partial skim can't hide "all fillers"). So we hide the block's rows
// by walking the shadow DOM (see applySkimCollapse) - the only site that folds rendered rows by
// hand, so a future block-fold API replaces just this file. (Locating the shadow root itself is
// shared: diffShadowRoot in diff-dom.ts.) The strip itself is a normal annotation (a render
// input, so it survives re-renders in both views).

// The guide entry for a path (or null) - file-level skim reads off it.
function guideEntry(path: string): GuideFile | null {
	return S.state?.guide?.files.find(g => g.path === path) ?? null
}

export function isFileSkim(path: string): boolean {
	return !!guideEntry(path)?.skim
}

export function fileSkimReason(path: string): string {
	return guideEntry(path)?.skimReason ?? ''
}

// ── Fully-skimmed files (issue 07) ───────────────────────────────────────────
// A file whose whole diff is skimmed (file-level flag, or every change block skim-stamped)
// leaves the reviewer's default flow: it gathers under the collapsed "Skimmed" tree/walkthrough/
// overview group and drops out of progress, review-complete, and the wrap/approve-advance seeks
// (navOrder). NOT auto-approved - approvedFiles is unchanged; the agent authored the skim and
// knows which files rode along. Opening one still works exactly like any file (its file/block
// skim strips render as issue 06 built), and explicitly approving it records sign-off as today.
//
// Derived per-render off current state, so it self-heals: a reload that re-resolves skims and
// drops a block's stamp (rewritten code) returns the file to the main flow automatically.
export function fileFullySkimmed(path: string): boolean {
	const blockSkims = (S.state?.changes ?? [])
		.filter(c => c.path === path)
		.map(c => !!c.skim)
	return isFullySkimmed(isFileSkim(path), blockSkims)
}

// ── Pure renames (issue 01) ──────────────────────────────────────────────────
// A file moved with identical content (distinct old/new paths, byte-equal old/new). It renders as
// a muted "renamed old → new · no changes" row and, like a fully-skimmed file, leaves the main
// review flow (folded into the Skimmed group, no progress/completion weight). Classified server-side
// by CONTENT equality (the lean builder's `renamePure` stamp, issue 04) rather than "zero change
// blocks", so a guide-merged rename-CHANGED file (issue 03, whose blocks are lazily client-derived)
// isn't misclassified as pure before it's opened. `movedFrom` returns the old path (or "").
export function fileMovedPure(path: string): boolean {
	return !!S.state?.files.find(x => x.path === path)?.renamePure
}
export function movedFrom(path: string): string {
	const f = S.state?.files.find(x => x.path === path)
	if (!f?.oldPath || !f.newPath || f.oldPath === f.newPath) return ''
	return f.oldPath
}

// A file that has left the reviewer's default flow: fully skimmed OR a pure rename. This is the
// single predicate the flow-control sites (tree/walkthrough grouping, nav order, progress, the
// approve-completion gate) check - so both kinds fold into the Skimmed group and drop out of the
// progress/completion math together. Skim-specific behavior (badges, collapse defaults, skim
// strips) keeps reading fileFullySkimmed directly.
export function fileOutOfFlow(path: string): boolean {
	return fileFullySkimmed(path) || fileMovedPure(path)
}

// The changed files that have left the main flow (fully skimmed or pure renames), in state.files
// order - the members of the collapsed group. Reads current state so it tracks reloads.
export function fullySkimmedPaths(): string[] {
	return (S.state?.files ?? []).map(f => f.path).filter(p => fileOutOfFlow(p))
}

// Per-session expand state for the collapsed "Skimmed" group, kept in S.skimExpanded (a sibling
// of the file:/block keys) under one sentinel so all three surfaces - tree, walkthrough, overview
// - share it. Not persisted: collapse is display-only and resets each session.
const SKIM_GROUP_KEY = 'group:skimmed'
export function isSkimGroupExpanded(): boolean {
	return S.skimExpanded.has(SKIM_GROUP_KEY)
}
export function toggleSkimGroup(): void {
	if (S.skimExpanded.has(SKIM_GROUP_KEY))
		S.skimExpanded.delete(SKIM_GROUP_KEY)
	else S.skimExpanded.add(SKIM_GROUP_KEY)
	// The tree/walkthrough re-derive reactively off S.skimExpanded; render() rebuilds the Overview
	// page when it's the one showing the group.
	void render()
}

// Collapse defaults invert for fully-skimmed files: they're already folded away behind the
// Skimmed tree group, so opening one is a deliberate "show me" - its diff renders expanded
// (collapsing it again would just make the reviewer click twice). Partially-skimmed files sit
// in the main flow, so their skimmed blocks still collapse by default (that's the feature).
// S.skimExpanded therefore stores TOGGLES from the per-file default, not absolute "expanded":
// the toggle handlers stay add/delete, and state = default XOR toggled.
function skimToggled(key: string): boolean {
	return S.skimExpanded.has(key)
}

// A file whose diff is collapsed right now. A file-level skim flag implies fully-skimmed, so
// these files default to expanded - collapsed only when the reviewer re-folded via the header.
export function isFileSkimCollapsed(path: string): boolean {
	return isFileSkim(path) && skimToggled(`file:${path}`)
}

// Skimmable change blocks on the current file (server-stamped). Only pending ones collapse -
// a decided block is already folded/replayed out of the diff, so skim no longer applies.
export function skimChanges(): ChangeState[] {
	return currentChanges().filter(c => c.skim && c.status === 'pending')
}

export function isBlockSkimCollapsed(c: ChangeState): boolean {
	if (!c.skim || c.status !== 'pending') return false
	const defaultCollapsed = !fileFullySkimmed(c.path)
	return defaultCollapsed !== skimToggled(c.id)
}

// The delimiter counts tail of a ChangeState stableKey (`side:line:deletions:additions`).
const SKIM_LINE_COUNTS = /:(?<dels>\d+):(?<adds>\d+)$/

// "N skimmed lines · reason" - N is the block's changed-line count (from its stableKey
// `side:line:dels:adds`), reason the agent's note (falls back to a bare "skimmed change").
export function skimStripLabel(c: ChangeState): string {
	const counts = c.stableKey?.match(SKIM_LINE_COUNTS)?.groups
	const count = counts ? Number(counts.dels) + Number(counts.adds) : 0
	const lines = count
		? `${count} skimmed line${count === 1 ? '' : 's'}`
		: 'skimmed change'
	const reason = c.skim?.reason?.trim()
	return reason ? `${lines} · ${reason}` : lines
}

export function toggleSkimBlock(id: string): void {
	if (S.skimExpanded.has(id)) S.skimExpanded.delete(id)
	else S.skimExpanded.add(id)
	void render()
}

export function toggleFileSkim(path: string): void {
	const key = `file:${path}`
	if (S.skimExpanded.has(key)) S.skimExpanded.delete(key)
	else S.skimExpanded.add(key)
	void render()
}

// Render the collapsed placeholder for a skim-flagged file: the whole diff folds behind one
// expandable strip (count of changes + reason). render() calls this instead of the @pierre
// diff while the file is collapsed; expanding falls through to the normal render.
export function renderFileSkim(): void {
	const file = currentFile()
	const n = currentChanges().filter(c => c.path === file.path).length
	const reason = fileSkimReason(file.path)
	// Untracked/new files carry no change blocks (they render as full-file additions), so fall
	// back to a plain "skimmed" rather than a bare "0 changes".
	const count = n ? `${n} change${n === 1 ? '' : 's'} · ` : ''
	$('diff').innerHTML = `<div class="file-skim">
    <button class="file-skim-strip">
      <span class="skim-caret">▸</span>
      <span class="file-skim-name">${esc(file.path)}</span>
      <span class="file-skim-meta">${count}${reason ? `${esc(reason)} - ` : ''}skimmed</span>
      <span class="file-skim-expand">Expand</span>
    </button>
  </div>`
	// The placeholder markup is rebuilt on every render, so this cannot stack listeners.
	$('diff')
		.querySelector<HTMLButtonElement>('.file-skim-strip')
		?.addEventListener('click', () => toggleFileSkim(file.path))
}

// The muted one-line row for a pure rename (issue 01): "renamed old → new · no changes". Unlike a
// skimmed file there's nothing to expand - the content is identical - so it's a static note, not a
// toggle. render() calls this instead of the @pierre diff when a moved-pure file is opened.
export function renderMovedPure(): void {
	const file = currentFile()
	const from = movedFrom(file.path)
	$('diff').innerHTML =
		`<div class="file-skim"><div class="file-skim-strip moved">
    <svg class="ic"><use href="#gly-arrow-right"></use></svg>
    <span>renamed <span class="file-skim-name">${esc(from)}</span> → <span class="file-skim-name">${esc(file.path)}</span></span>
    <span class="file-skim-meta">no changes</span>
  </div></div>`
}

// Collapse every skimmed (not-expanded) block on the current file by hiding its rendered rows.
// Called synchronously in render()'s afterRender - before the browser paints - so there's no
// expand-then-collapse flash, and re-run every render so it survives @pierre's internal
// re-renders into a cached instance. Idempotent: prior hides (data-skim-hidden) are cleared
// first, since a cached instance reuses its row elements across renders.
//
// Purely structural (no geometry): each @pierre column is a <code> holding a [data-gutter] and a
// [data-content] grid track, 1:1 by index, and split renders two columns whose rows the grid
// aligns. The context lines bounding a block carry the same data-line-index in BOTH columns, so
// they pin the block's band on each side without measuring - we hide every cell strictly between
// them (the change rows on one side, the paired unlabeled filler rows on the other, plus the
// gutters). Measurement was tried and abandoned: rects aren't laid out yet in afterRender.
// A block's display band plus the @pierre line-type its change rows carry.
type BlockRange = { lineType: string; first: number; last: number }

// One rendered column: the code element's two grid tracks (gutter + content), either of which a
// shape change could leave absent.
type DiffColumn = { gutter: HTMLElement | null; content: HTMLElement | null }

// A row's data-line-index bounds: the context rows bracketing a block in the anchor's column.
type BlockBounds = { before: string | null; after: string | null }

function blockRange(block: ChangeState): BlockRange {
	const first = block.displayLineNumber ?? block.lineNumber
	return {
		lineType:
			block.side === 'additions' ? 'change-addition' : 'change-deletion',
		first,
		last: block.displayEndLine ?? block.endLine ?? first,
	}
}

// Clear the previous pass's hidden rows: a cached instance reuses its row elements across
// renders, so each fold starts from a clean slate.
function unhideSkimRows(shadow: ShadowRoot): void {
	for (const el of shadow.querySelectorAll<HTMLElement>(
		'[data-skim-hidden]',
	)) {
		el.style.display = ''
		el.removeAttribute('data-skim-hidden')
	}
}

// The columns of the rendered diff. Queried in two steps (each selector on its own): a combined
// selector string reads as a Tailwind class list to nextnode/no-detached-tailwind.
function diffColumns(shadow: ShadowRoot): DiffColumn[] {
	const columns: DiffColumn[] = []
	for (const pre of shadow.querySelectorAll('pre[data-diff]'))
		for (const code of pre.querySelectorAll('code[data-code]'))
			columns.push({
				gutter: code.querySelector<HTMLElement>('[data-gutter]'),
				content: code.querySelector<HTMLElement>('[data-content]'),
			})
	return columns
}

// A change cell of this block - its display line falls inside the block's band. Selected by
// attribute (not one combined selector) to stay clear of nextnode/no-detached-tailwind.
function anchorInColumn(
	column: DiffColumn,
	range: BlockRange,
): HTMLElement | null {
	for (const cell of column.content?.querySelectorAll<HTMLElement>(
		'[data-line]',
	) ?? []) {
		if (cell.getAttribute('data-line-type') !== range.lineType) continue
		const line = Number(cell.getAttribute('data-line'))
		if (line >= range.first && line <= range.last) return cell
	}
	return null
}

// The block's anchor cell, from the first column that renders this block's side.
function blockAnchor(
	columns: DiffColumn[],
	range: BlockRange,
): HTMLElement | null {
	for (const column of columns) {
		const anchor = anchorInColumn(column, range)
		if (anchor) return anchor
	}
	return null
}

function isContextRow(el: Element | null): boolean {
	return (
		!!el && (el.getAttribute('data-line-type') ?? '').startsWith('context')
	)
}

function siblingRows(anchor: HTMLElement): HTMLElement[] {
	const parent = anchor.parentElement
	if (!parent) return []
	return [...parent.children].filter(el => el instanceof HTMLElement)
}

// The band a block occupies in the anchor's column: from its change cell out to the context rows
// that bracket it (the hunk edge when a side has none).
function blockBand(siblings: HTMLElement[], anchorIndex: number): BlockBounds {
	let lower = anchorIndex
	while (lower > 0 && !isContextRow(siblings[lower - 1])) lower--
	let upper = anchorIndex
	while (upper < siblings.length - 1 && !isContextRow(siblings[upper + 1]))
		upper++
	return {
		before: siblings.at(lower - 1)?.getAttribute('data-line-index') ?? null,
		after: siblings.at(upper + 1)?.getAttribute('data-line-index') ?? null,
	}
}

function trackRows(track: HTMLElement | null): HTMLElement[] {
	if (!track) return []
	return [...track.children].filter(el => el instanceof HTMLElement)
}

// The rows of one track to hide: everything strictly between the two bounding context rows,
// keeping the annotation rows (that's where the skim strip lives). A bound the diff placed only on
// the other side isn't in this track - skip rather than risk hiding from the wrong edge.
function hiddenTrackRows(
	track: HTMLElement | null,
	bounds: BlockBounds,
): HTMLElement[] {
	const rows = trackRows(track)
	const indexOfLine = (lineIndex: string): number =>
		rows.findIndex(row => row.getAttribute('data-line-index') === lineIndex)
	const start = bounds.before ? indexOfLine(bounds.before) : -1
	const end = bounds.after ? indexOfLine(bounds.after) : rows.length
	if ((bounds.before && start === -1) || (bounds.after && end === -1))
		return []
	const hidden: HTMLElement[] = []
	for (let index = start + 1; index < end; index++) {
		const row = rows.at(index)
		if (row && !row.hasAttribute('data-line-annotation')) hidden.push(row)
	}
	return hidden
}

// The rendered rows this block hides, across every column's gutter and content track.
function blockHiddenRows(
	columns: DiffColumn[],
	block: ChangeState,
): HTMLElement[] {
	const anchor = blockAnchor(columns, blockRange(block))
	if (!anchor) return []
	const siblings = siblingRows(anchor)
	const anchorIndex = siblings.indexOf(anchor)
	if (anchorIndex < 0) return []
	const bounds = blockBand(siblings, anchorIndex)
	const hidden: HTMLElement[] = []
	for (const column of columns) {
		hidden.push(
			...hiddenTrackRows(column.gutter, bounds),
			...hiddenTrackRows(column.content, bounds),
		)
	}
	return hidden
}

export function applySkimCollapse(): void {
	const blocks = currentChanges().filter(c => isBlockSkimCollapsed(c))
	const shadow = diffShadowRoot()
	if (!shadow) {
		// Blocks want collapsing but the diff shadow isn't up yet - a cold mount where render()
		// resolved before @pierre committed the rows. onPostRender re-invokes us once it is, so
		// this is a transient early-out, not a defect to surface.
		return
	}
	unhideSkimRows(shadow)
	if (!blocks.length) return
	const columns = diffColumns(shadow)
	const rows = blocks.flatMap(block => blockHiddenRows(columns, block))
	for (const row of rows) {
		row.style.display = 'none'
		row.setAttribute('data-skim-hidden', '1')
	}
	// Rows to collapse but none hidden = the anchor/context lookup missed (shape drift in
	// @pierre's DOM). Surface it to the reviewer instead of silently leaving the block expanded.
	if (!rows.length) toast(`Skim: ${blocks.length} block(s) stayed visible`)
}
