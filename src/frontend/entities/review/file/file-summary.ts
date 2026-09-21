import type { ReviewFile } from '../model'

export function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown|mdx)$/i.test(path)
}

// Select the initial view before contents arrive: a parsed diff opens as source, while a
// hunkless new/unchanged Markdown artifact opens rendered. The explicit preference still wins.
// The explicit preference arrives as its own narrow union - the settings slice stays
// decoupled (same-layer slices don't import each other's models).
export function defaultFileView(
	file: Pick<ReviewFile, 'path' | 'hasHunks'>,
	preference: 'auto' | 'rendered' | 'source',
): 'rendered' | 'source' {
	if (!isMarkdownPath(file.path)) return 'source'
	if (preference !== 'auto') return preference
	return file.hasHunks ? 'source' : 'rendered'
}

export function reviewLineCount(
	file: Pick<ReviewFile, 'hasHunks' | 'added' | 'removed'>,
): number {
	// Preserve the receipt's historic hunk-only count: hunkless full-file adds still contribute 0.
	return file.hasHunks ? file.added + file.removed : 0
}
