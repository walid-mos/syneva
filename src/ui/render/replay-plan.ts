import type {
	DiffAcceptRejectHunkConfig,
	DiffAcceptRejectHunkType,
	FileDiffMetadata,
} from '@pierre/diffs'
import type { DecidedPosition } from '../linemap'

// Pure half of the decision replay, kept free of the store so it stays testable on its own:
// which library call resolves which decided block.
export type ReplayCall = {
	hunkIndex: number
	options: DiffAcceptRejectHunkConfig | DiffAcceptRejectHunkType
}

// One library call per decided block copies the whole diff, and the copy is the cost: measured
// ~180 ms for 925 decisions on a 3 700-line file, which made an approve-all click grow with the
// file. The library also resolves a whole hunk in a single call (the bare type, no config), which
// is the same resolution whenever every change of that hunk is decided the same way - the common
// case, "Approve ⇧A" included. Grouping consecutive decisions of one hunk (decidedPositions keeps
// the order it computed them in) collapses those into one call and leaves mixed hunks on the
// per-change path. replay-decisions.test.ts pins both the grouping and the library equivalence.
export function planReplayCalls(
	diff: FileDiffMetadata,
	decided: DecidedPosition[],
): ReplayCall[] {
	const calls: ReplayCall[] = []
	let index = 0
	while (index < decided.length) {
		const { hunkIndex } = decided[index]
		let end = index
		while (end < decided.length && decided[end].hunkIndex === hunkIndex)
			end++
		const group = decided.slice(index, end)
		const whole =
			group.every(d => d.status === group[0].status) &&
			group.length === changeCount(diff, hunkIndex)
		if (whole) {
			calls.push({
				hunkIndex,
				options: group[0].status === 'rejected' ? 'reject' : 'accept',
			})
		} else {
			calls.push(...perChangeCalls(group))
		}
		index = end
	}
	return calls
}

// The library's per-change form, one call per decided block - the path mixed hunks stay on.
function perChangeCalls(group: DecidedPosition[]): ReplayCall[] {
	return group.map(d => ({
		hunkIndex: d.hunkIndex,
		options: {
			type: d.status === 'rejected' ? 'reject' : 'accept',
			changeIndex: d.changeIndex,
		},
	}))
}

function changeCount(diff: FileDiffMetadata, hunkIndex: number): number {
	// `.at` rather than `[hunkIndex]`: the index comes from a decision record, so it can outlive the diff
	// it was made against (a reload can shrink the file), and this is the check that catches that.
	const hunk = diff.hunks.at(hunkIndex)
	if (!hunk) return 0
	return hunk.hunkContent.filter(part => part.type === 'change').length
}
