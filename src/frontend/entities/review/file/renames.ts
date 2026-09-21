import type { ReviewFile } from '../model'

// ── Pure renames (issue 01) ──────────────────────────────────────────────────
// A file moved with identical content (distinct old/new paths, byte-equal contents) renders as a
// muted "renamed old → new · no changes" note instead of a diff, and leaves the reviewer's default
// flow: it gathers under the collapsed "Renamed" tree/walkthrough group with no progress weight and
// stays out of the nav order (flow-index's outOfFlow set). Classified server-side by CONTENT
// equality (the lean builder's `renamePure` stamp) rather than "zero changed lines", so a
// moved-AND-edited file isn't misclassified as pure before it's opened.

// The old path of a pure rename, or "" when the path isn't one (the templates' truthy convention).
export function movedFrom(files: ReviewFile[], path: string): string {
	const file = files.find(f => f.path === path)
	if (!file?.oldPath || !file.newPath || file.oldPath === file.newPath)
		return ''
	return file.oldPath
}

// A file moved with identical content: there is nothing to diff, so the note replaces the diff view.
export function fileMovedPure(files: ReviewFile[], path: string): boolean {
	return !!files.find(f => f.path === path)?.renamePure
}

const RENAMED_GROUP_KEY = 'group:renamed'

// Per-session expand state of the trailing "Renamed" group (pure renames, issue 01), keyed
// beside the Reviewed group's sentinel in the session fold set. Not persisted: folding is
// display-only. The toggle mutates the set the caller owns; rows re-derive reactively and the
// caller repaints.
export function isRenamedGroupExpanded(foldExpanded: Set<string>): boolean {
	return foldExpanded.has(RENAMED_GROUP_KEY)
}

export function toggleRenamedGroup(foldExpanded: Set<string>): void {
	if (foldExpanded.has(RENAMED_GROUP_KEY))
		foldExpanded.delete(RENAMED_GROUP_KEY)
	else foldExpanded.add(RENAMED_GROUP_KEY)
}
