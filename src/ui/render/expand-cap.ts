// Whole-file rendering (the "expand unchanged lines" setting) paints every row of the file -
// a 10k-line file becomes tens of thousands of DOM cells rebuilt synchronously on every render
// pass, even with tokenization pushed into the worker pool. Files past EXPAND_LINES_MAX new-side
// lines render hunks-only instead; the diff header notes the cap (file-header.ts). The threshold
// is a paint-budget line, not a review-quality rule: the desk's oversized stamp (>5k changed
// lines, src/state/diff-files.ts) covers rewrite-sized diffs long before this binds.
export const EXPAND_LINES_MAX = 5_000

const NEWLINE = 10

// Count newlines in one pass: match(/\n/g) allocates a full array of every newline across
// what can be a multi-MB contents string, on every render - the count is all we need.
export function newLines(contents: string): number {
	let count = 1
	for (let i = 0; i < contents.length; i++)
		if (contents.charCodeAt(i) === NEWLINE) count++
	return count
}

export function isExpandCapped(newContents: string): boolean {
	return newLines(newContents) > EXPAND_LINES_MAX
}
