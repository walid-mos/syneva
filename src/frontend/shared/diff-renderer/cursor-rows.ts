import type { Side } from './types'

// The other column's coordinates of a visually identical row (see mergeRows).
export type RowTwin = { side: Side; line: number }

// The measured data this module orders and merges - deliberately DOM-free, so the pure pass (and
// its test) needs no rendered element.
export type MeasuredRow = {
	side: Side
	line: number
	top: number
	// The split-view twin of a context row (see mergeRows): kept so a cursor seeded from either
	// column still matches this row.
	alt?: RowTwin
}

// A measured row plus what only the cursor itself uses: the element to paint and its height.
export type Row = MeasuredRow & {
	el?: HTMLElement
	height: number
	change: boolean
}

// Additions-side rows sort first when two rows share a y: the additions column is the primary
// one, so a merged context pair keeps its additions cell.
function compareSide(a: Side, b: Side): number {
	if (a === b) return 0
	return a === 'additions' ? -1 : 1
}

// Sort measured rows top-to-bottom (additions before deletions when they share a y) and merge the
// split-view twins of a context line - the additions- and deletions-column cells that render at
// the same visual line - into ONE row, keeping the additions side primary and the deletions
// coordinate as `alt` so a cursor seeded from either column still matches. Pure over the measured
// list; the getBoundingClientRect sweep that produces `out` lives in cursor.ts (rows()).
export function mergeRows<T extends MeasuredRow>(out: T[]): T[] {
	out.sort((a, b) => a.top - b.top || compareSide(a.side, b.side))
	const seen = new Map<number, T>()
	const list: T[] = []
	for (const r of out) {
		const k = Math.round(r.top)
		const kept = seen.get(k)
		if (kept) {
			kept.alt = { side: r.side, line: r.line }
			continue
		}
		seen.set(k, r)
		list.push(r)
	}
	return list
}
