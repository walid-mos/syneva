// The provisional slice painted while a cold file is parsed: which rows, and whether the file is long
// enough for them to be worth painting at all. Kept free of DOM and render imports so the arithmetic
// that decides what a reviewer reads - line numbering included - is testable on its own
// (render/placeholder.ts owns the surface and the cold-open policy).

import { newLines } from './expand-cap'

// The parse a placeholder hides has to be long enough to be worth a second pass: it is ~5 ms at 400
// lines, i.e. shorter than the paint the layer itself costs, and a flash of provisional rows would
// read as a glitch rather than as speed.
export const PLACEHOLDER_MIN_LINES = 400
// Rows painted: enough to fill a tall pane and cheap to build from one prefix of the contents.
const PLACEHOLDER_ROWS = 64
// A minified file's opening line can be a megabyte; these rows are read for a moment, so the layer
// carries a prefix of each line instead of the whole file's worth of DOM.
const MAX_LINE_CHARS = 400

export type PlaceholderRow = { no: number; text: string }

// The file's opening rows, numbered the way the diff numbers its new side. A file ending in a newline
// has no line after it, so the split's trailing empty string is not a row - and a file longer than
// `rows` leaves the unsplit remainder in the last slot, which is not a line either.
export function placeholderRows(
	contents: string,
	rows = PLACEHOLDER_ROWS,
): PlaceholderRow[] {
	if (!contents) return []
	const lines = contents.split('\n', rows + 1)
	if (lines.length > rows) lines.pop()
	else if (lines.at(-1) === '') lines.pop()
	return lines.map((line, index) => ({
		no: index + 1,
		text:
			line.length > MAX_LINE_CHARS
				? `${line.slice(0, MAX_LINE_CHARS)}…`
				: line,
	}))
}

// Whether the upcoming pass is worth a provisional paint: below this the parse is shorter than the
// layer costs to show and remove.
export function shouldPlaceholder(contents: string): boolean {
	return newLines(contents) > PLACEHOLDER_MIN_LINES
}
