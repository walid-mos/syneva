import type { FileDiffMetadata } from '@pierre/diffs'
import type { Side } from './types'

// ── Raw ↔ display line mapping ───────────────────────────────────────────────
// Syneva keeps every persisted anchor (decisions, comments, ChangeState) in RAW
// coordinates: line numbers in the actual old/new file, as the unresolved diff
// numbers them. But the rendered diff is the *replayed* one, and @pierre's
// resolveRegion renumbers it on every resolution: an accepted block's additions
// are spliced into the deletion side as context (shifting every later
// deletion-side line by additions - deletions), and a rejected block shifts the
// addition side symmetrically. This map converts between the two spaces so
// annotations land on rendered rows and selections persist as real file lines.

export type LineMap = {
	toDisplay(side: Side, line: number): number
	fromDisplay(side: Side, line: number): number
}

type Break = { after: number; delta: number } // raw lines > `after` shift by `delta`
type HunkPart = NonNullable<
	FileDiffMetadata['hunks'][number]['hunkContent']
>[number]
type ChangePart = Extract<HunkPart, { type: 'change' }>

export type DecidedPosition = {
	hunkIndex: number
	changeIndex: number
	// 'cut' = an accepted block the hide-reviewed pref distills out: the band renders
	// nothing, so both sides' display streams contract at it (see pushBreak).
	status: 'accepted' | 'rejected' | 'cut'
}

const IDENTITY: LineMap = { toDisplay: (_s, l) => l, fromDisplay: (_s, l) => l }

export function identityLineMap(): LineMap {
	return IDENTITY
}

// A decided CHANGE part shifts one side by additions - deletions; context parts and net-zero
// changes produce no visible shift. The deltas encode what each side's display stream
// consumes for the section:
// - accepted (visible): the deletions are spliced out, the additions ride along as context
//   on the deletion side.
// - rejected: the additions are spliced out, the deletions ride along on the addition side.
// - cut (accepted + hidden): the band is distilled out of the rendered diff entirely, so
//   both streams skip their whole raw extent: everything from the band's first raw line on
//   compresses by exactly `dels` (deletions side) / `adds` (additions side) - even when the
//   two counts are equal, unlike the visible cases where equal means zero shift.
function pushBreak(
	breaks: Record<Side, Break[]>,
	decided: DecidedPosition,
	part: ChangePart,
): void {
	const dels = part.deletions
	const adds = part.additions
	if (decided.status === 'cut') {
		// Both streams skip the whole band: one break each, placed at the band's first raw
		// display line (everything from there on compresses). NOTE for equal dels/adds the
		// visible cases' early return does NOT apply - the band still vanishes.
		breaks.deletions.push({
			after: part.deletionLineIndex,
			delta: -dels,
		})
		breaks.additions.push({
			after: part.additionLineIndex,
			delta: -adds,
		})
		return
	}
	if (adds === dels) return
	if (decided.status === 'accepted') {
		// Accept keeps the additions; the deletion side now shows them as context.
		breaks.deletions.push({
			after: part.deletionLineIndex + dels,
			delta: adds - dels,
		})
		return
	}
	// Reject keeps the deletions; the addition side now shows them as context.
	breaks.additions.push({
		after: part.additionLineIndex + adds,
		delta: dels - adds,
	})
}

// Build the map from the RAW diff plus the set of decided change blocks. Raw
// positions (hunkIndex, contentIndex) are invariant under resolveRegion, so the
// breakpoints can be read straight off the unresolved diff in document order.
export function buildLineMap(
	rawDiff: FileDiffMetadata,
	decided: DecidedPosition[],
): LineMap {
	const breaks: Record<Side, Break[]> = { additions: [], deletions: [] }
	for (const d of decided) {
		const part = rawDiff.hunks
			.at(d.hunkIndex)
			?.hunkContent.at(d.changeIndex)
		if (part?.type !== 'change') continue
		pushBreak(breaks, d, part)
	}
	if (!breaks.additions.length && !breaks.deletions.length) return IDENTITY
	breaks.additions.sort((a, b) => a.after - b.after)
	breaks.deletions.sort((a, b) => a.after - b.after)
	const toDisplay = (side: Side, line: number): number => {
		let off = 0
		for (const b of breaks[side]) {
			if (b.after >= line) break
			off += b.delta
		}
		return line + off
	}
	const fromDisplay = (side: Side, line: number): number => {
		// Invert the step function piecewise. Negative deltas (a resolved block removed
		// lines from this side) make naive piece ranges overlap with phantom values for the
		// removed lines - but rendered numbering is contiguous and monotone, so the LAST
		// piece whose display range contains the line is the one actually rendered there.
		const bs = breaks[side]
		let prefix = bs.reduce((sum, b) => sum + b.delta, 0)
		for (let i = bs.length - 1; i >= 0; i--) {
			if (line > bs[i].after + prefix) return line - prefix
			prefix -= bs[i].delta
		}
		return line // before the first break: identity
	}
	return { toDisplay, fromDisplay }
}
