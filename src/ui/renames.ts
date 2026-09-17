import { currentFile } from './changes'
import { render } from './render'
import { $, esc, S } from './store'

import type { ReviewState } from './types'

// The browser-side file shape: the desk's lean ReviewFile (ui/types re-exports it aliased).
type ReviewFile = ReviewState['files'][number]

// ── Pure renames (issue 01) ──────────────────────────────────────────────────
// A file moved with identical content (distinct old/new paths, byte-equal contents) renders as a
// muted "renamed old → new · no changes" note instead of a diff, and leaves the reviewer's default
// flow: it gathers under the collapsed "Renamed" tree/walkthrough group with no progress weight and
// stays out of the nav order (flow-index's outOfFlow set). Classified server-side by CONTENT
// equality (the lean builder's `renamePure` stamp) rather than "zero changed lines", so a
// moved-AND-edited file isn't misclassified as pure before it's opened.

function fileFor(path: string): ReviewFile | undefined {
	return S.state?.files.find(f => f.path === path)
}

// The old path of a pure rename, or "" when the path isn't one (the templates' truthy convention).
export function movedFrom(path: string): string {
	const file = fileFor(path)
	if (!file?.oldPath || !file.newPath || file.oldPath === file.newPath)
		return ''
	return file.oldPath
}

// A file moved with identical content: there is nothing to diff, so the note replaces the diff view.
export function fileMovedPure(path: string): boolean {
	return !!fileFor(path)?.renamePure
}

const RENAMED_GROUP_KEY = 'group:renamed'

// Per-session expand state of the trailing "Renamed" group (pure renames, issue 01), keyed
// beside the Reviewed group's sentinel in S.foldExpanded. Not persisted: folding is display-only.
export function isRenamedGroupExpanded(): boolean {
	return S.foldExpanded.has(RENAMED_GROUP_KEY)
}

export function toggleRenamedGroup(): void {
	if (S.foldExpanded.has(RENAMED_GROUP_KEY))
		S.foldExpanded.delete(RENAMED_GROUP_KEY)
	else S.foldExpanded.add(RENAMED_GROUP_KEY)
	// The tree/walkthrough rows re-derive reactively off S.foldExpanded; the render refreshes the
	// landing card when it's the one showing.
	void render()
}

// The muted one-line note for a pure rename. render() calls this instead of the @pierre diff when a
// moved-pure file is opened.
export function renderMovedPure(): void {
	const file = currentFile()
	const from = movedFrom(file.path)
	$('diff').innerHTML =
		`<div class="file-note"><div class="file-note-strip moved">
    <svg class="ic"><use href="#gly-arrow-right"></use></svg>
    <span>renamed <span class="file-note-name">${esc(from)}</span> → <span class="file-note-name">${esc(file.path)}</span></span>
    <span class="file-note-meta">no changes</span>
  </div></div>`
}
