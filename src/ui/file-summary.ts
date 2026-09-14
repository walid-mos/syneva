import type { BrowserReviewFile } from '../types'
import type { Settings } from './types'

export function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown|mdx)$/i.test(path)
}

// Select the initial view before contents arrive: a parsed diff opens as source, while a
// hunkless new/unchanged Markdown artifact opens rendered. The explicit preference still wins.
export function defaultFileView(
	file: Pick<BrowserReviewFile, 'path' | 'hasHunks'>,
	preference: Settings['markdownView'],
): 'rendered' | 'source' {
	if (!isMarkdownPath(file.path)) return 'source'
	if (preference !== 'auto') return preference
	return file.hasHunks ? 'source' : 'rendered'
}

export function reviewLineCount(
	file: Pick<BrowserReviewFile, 'hasHunks' | 'added' | 'removed'>,
): number {
	// Preserve the receipt's historic hunk-only count: hunkless full-file adds still contribute 0.
	return file.hasHunks ? file.added + file.removed : 0
}
