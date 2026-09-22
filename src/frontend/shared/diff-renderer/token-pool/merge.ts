// Window-result merge: assembles worker window results into one full result object the renderer
// can consume. Holes are forbidden - @pierre's processDiffResult throws on rows where BOTH sides
// lack content ("deletionLine and additionLine are null") - so the grid starts as a full-file
// PLAIN render (every slot has a row; expandedHunks=true covers every expansion state), and each
// token window overwrites the rows at its replayed per-side content indexes (@pierre looks rows
// up by diff-side lineIndex, so a merged result is grid-indexed, not sequential). Rows are hast
// ElementContent nodes per @pierre's Result shape; we route them, never inspect them.
import type { ThemedDiffResult } from '@pierre/diffs'
import type { WindowSpec } from '@shared/diff-renderer/token-pool/windows'

// Per-side content indexes for a window's rows, in render order (the worker's segment walk).
export type WindowPositions = { deletion: number[]; addition: number[] }
export type WindowResultPayload = {
	code: ThemedDiffResult['code']
	positions: WindowPositions
}

type SideScatter = {
	grid: unknown[]
	rows: unknown[]
	positions: number[]
}

type SideName = 'deletion' | 'addition'

// A job's merge target: owns its skeleton copy so window merges mutate own state (not caller
// arguments) while the originally computed plain render stays upstream-reusable.
export class MergeGrid {
	constructor(private grid: ThemedDiffResult) {}

	result(): ThemedDiffResult {
		return this.grid
	}

	// Scatter one window's rows onto its side grids. Row count must equal position count per
	// side - a drift means the worker's segment walk and its token render disagreed, which
	// would silently paint wrong rows; fail loud instead.
	mergeWindow(window: WindowSpec, payload: WindowResultPayload): void {
		const sides: [SideName, SideScatter][] = [
			[
				'deletion',
				{
					grid: this.grid.code.deletionLines,
					rows: payload.code.deletionLines,
					positions: payload.positions.deletion,
				},
			],
			[
				'addition',
				{
					grid: this.grid.code.additionLines,
					rows: payload.code.additionLines,
					positions: payload.positions.addition,
				},
			],
		]
		for (const [side, scatter] of sides) {
			assertAligned(window, side, scatter.rows, scatter.positions)
			for (const [index, row] of scatter.rows.entries())
				scatter.grid[scatter.positions[index]] = row
		}
	}
}

// The skeleton is a private copy: the plain render's grids stay reusable while windows mutate
// rows in place, and a fresh skeleton per options version must not inherit a half-merged state.
export function createSkeleton(plain: ThemedDiffResult): ThemedDiffResult {
	return {
		code: {
			deletionLines: plain.code.deletionLines.slice(),
			additionLines: plain.code.additionLines.slice(),
		},
		themeStyles: plain.themeStyles,
		baseThemeType: plain.baseThemeType,
	}
}

function assertAligned(
	window: WindowSpec,
	side: SideName,
	rows: unknown[],
	positions: number[],
): void {
	if (rows.length !== positions.length)
		throw new Error(
			`mergeWindowInto: ${window.kind} window rows=${rows.length} but positions=${positions.length} on ${side} side (startingLine=${window.startingLine})`,
		)
	// Same content index twice inside one window would mean the worker replayed overlapping
	// iterations; the merged result would race on which row wins. Impossible with disciplined
	// walks - better to crash than to paint a shuffled file.
	const seen = new Set<number>()
	for (const position of positions) {
		if (seen.has(position))
			throw new Error(
				`mergeWindowInto: duplicate content index ${position} on ${side} side of ${window.kind} window (startingLine=${window.startingLine})`,
			)
		seen.add(position)
	}
}
