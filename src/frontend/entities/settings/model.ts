// Frontend-owned settings model: the display preferences persisted to
// ~/.syneva/settings.json via /api/settings (see the settings API boundary).
// User preferences (persisted to ~/.syneva/settings.json via /api/settings), applied live.
// diffStyle stays separate (its own toolbar toggle); these are the rest of the settings panel.
export type Settings = {
	lineDiffType: 'word-alt' | 'word' | 'char' | 'none'
	diffIndicators: 'bars' | 'classic' | 'none'
	hunkSeparators: 'line-info' | 'simple' | 'metadata' | 'line-info-basic'
	overflow: 'scroll' | 'wrap'
	// Row add/remove tint emphasis: full (default), subtle (faint row + stronger word
	// emphasis), off (no row tint - focus entirely on the word diff).
	lineHighlight: 'full' | 'subtle' | 'off'
	// UI chrome palette: "dark" (default) or "light". Drives the [data-theme] attribute on
	// <html> (which swaps the CSS custom-property palette) and the @pierre diff themeType.
	// Independent of `theme` below - any code theme can pair with either appearance.
	appearance: 'dark' | 'light'
	theme: string // Shiki bundled theme (dark or light) - applies to the diff AND comment code
	font: string // key into the FONTS map - code font (diff + comment/markdown code)
	uiFont: string // key into the SANS_FONTS map - UI chrome font (non-code)
	fontSize: number // px - code font size (diff + comment code)
	tabSize: number // columns - rendered width of tab characters in the diff
	showUnchanged: boolean
	// Diff view: "collapse" (default) folds long unchanged runs into a "N unmodified lines"
	// separator; "expand" renders every line (mapped to @pierre's expandUnchanged flag).
	unchangedLines: 'collapse' | 'expand'
	// How guided-review progress is weighted: "lines" (changed lines per file - finishing a
	// bigger change advances more) or "files" (every file counts the same).
	progressBy: 'lines' | 'files'
	// Which sidebar pane a guided desk opens with; `w` toggles per-session from there.
	sidebarDefault: 'tree' | 'walkthrough'
	// Default view for a markdown file: "auto" (new/unchanged → rendered, changed → source so the
	// diff shows first), or force "rendered"/"source". The toolbar toggle still overrides per file.
	markdownView: 'auto' | 'rendered' | 'source'
	// Distill round-over-round reviewed material (issue: multi-round reviews): hide change blocks
	// already ACCEPTED out of the current diff, and fold fully-approved files out of the tree and
	// walkthrough into a collapsed "Reviewed" group, gathering what still needs eyes. OFF by
	// default; the header toggle (⇧H) flips it for the whole session; display only - decisions,
	// progress, and the review-complete gate are untouched.
	hideReviewed: boolean
	stageOnAccept: boolean
	// Command template for "Open in editor" ({repo}/{file}/{line} placeholders). A machine
	// preference like the rest - empty falls back to the OS opener (see the editor outbound
	// adapter, src/backend/adapters/outbound/editor/editor.ts).
	editorCommand: string
}
