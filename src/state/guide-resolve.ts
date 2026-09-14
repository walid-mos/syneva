import { changeStableKeyFromBlock } from '../git/change.js'

import { changeKey, filePathOf } from './diff-files.js'

import type {
	ChangeState,
	DiffFile,
	DiffHunk,
	DiffLine,
	Guide,
	GuideFile,
	ReviewFile,
	ReviewState,
} from '../types.js'

export type SkimResolution = { ok: true } | { ok: false; reason: string }

// A change block's stable key + the new-file-side line range it occupies, for matching a guide's
// skimBlocks spans.
type SkimRange = { stableKey: string; lo: number; hi: number }

// A guide file's skimBlocks entry, narrowed to the two fields the resolver reads.
type SkimSpan = { lines: [number, number]; reason?: string }

// What stampSkimBlocks needs to resolve one file's spans: the diff ranges they may match, the changes
// to stamp, and whether an unmatched span is fatal.
type SkimStampInput = {
	filePath: string
	spans: SkimSpan[]
	rangesByKey: SkimRange[] | undefined
	changeByKey: Map<string, ChangeState>
	isStrict: boolean
}

// Resolve a guide's skimBlocks (new-file-side line spans) to the change blocks they enclose and
// stamp `skim` onto those ChangeState records. Diff-aware, so it lives here rather than in the pure
// validateGuide. Display-only: it never touches decisions/status. `strict` (initial attach or
// reload-with-a-NEW-guide) REJECTS a span that matches no block - or a skimBlocks entry on a file
// absent from the diff - naming the offending path+span, so a bad guide is caught up front.
// Non-strict (a reload carrying the SAME guide forward) DROPS an unresolvable span silently: the
// diff advanced under the guide, and a block that changed deserves fresh attention, not a stale
// collapse. Idempotent - clears prior stamps first. File-level `skim` is a whole-file flag and needs
// no resolution, so it isn't handled here. Takes the already-parsed diff (parsedDiffOf) so the same
// multi-MB rawDiff isn't parsed a second time (issue 06).
export function resolveSkim(
	parsedDiff: DiffFile[],
	changes: ChangeState[],
	guide: Guide,
	opts: { strict: boolean },
): SkimResolution {
	for (const change of changes) delete change.skim
	const rangesByPath = skimRangesByPath(parsedDiff)
	const changeByKey = new Map(
		changes.map(change => [changeKey(change), change]),
	)
	for (const file of guide.files) {
		if (!file.skimBlocks?.length) continue
		const reason = stampSkimBlocks({
			filePath: file.path,
			spans: file.skimBlocks,
			rangesByKey: rangesByPath.get(file.path),
			changeByKey,
			isStrict: opts.strict,
		})
		if (reason) return { ok: false, reason }
	}
	return { ok: true }
}

function stampSkimBlocks(input: SkimStampInput): string | undefined {
	const ranges = input.rangesByKey ?? []
	for (const span of input.spans) {
		const reason = stampSpan(input, span, ranges)
		if (reason) return reason
	}
	return undefined
}

// One span against the file's ranges: stamp every block it encloses, or report why a strict guide
// rejects it (undefined when it is merely stale).
function stampSpan(
	input: SkimStampInput,
	span: SkimSpan,
	ranges: SkimRange[],
): string | undefined {
	const [lo, hi] = span.lines
	const matched = ranges.filter(range => lo <= range.hi && hi >= range.lo)
	if (!matched.length) return unmatchedSpanReason(input, span)
	stampMatched(input, matched, span.reason)
	return undefined
}

// A span matching no change block fails a strict guide (naming the path + span) and is dropped by a
// lenient one.
function unmatchedSpanReason(
	input: SkimStampInput,
	span: SkimSpan,
): string | undefined {
	if (!input.isStrict) return undefined
	const [lo, hi] = span.lines
	return `guide skimBlocks span [${lo}, ${hi}] on "${input.filePath}" matches no change in the diff`
}

function stampMatched(
	input: SkimStampInput,
	matched: SkimRange[],
	reason: string | undefined,
): void {
	for (const range of matched) {
		const change = input.changeByKey.get(
			`${input.filePath}:${range.stableKey}`,
		)
		if (change) change.skim = { reason }
	}
}

// Every hunk's change-block ranges, per reviewed file path.
function skimRangesByPath(parsedDiff: DiffFile[]): Map<string, SkimRange[]> {
	const rangesByPath = new Map<string, SkimRange[]>()
	for (const file of parsedDiff) {
		const filePath = filePathOf(file)
		const ranges = rangesByPath.get(filePath) ?? []
		for (const hunk of file.hunks) ranges.push(...skimRangesForHunk(hunk))
		rangesByPath.set(filePath, ranges)
	}
	return rangesByPath
}

// A block with additions spans its added lines' new-side numbers; a pure-deletion block has no
// new-side line of its own, so it falls back to the preceding new line (its insertion point) -
// best-effort, since skim targets additive churn (imports, lockfiles) and deletions are the rare
// edge (see the guide docs in spec.ts).
function skimRangesForHunk(hunk: DiffHunk): SkimRange[] {
	const ranges: SkimRange[] = []
	let block: DiffLine[] = []
	let previousNewLine = hunk.newStart - 1 // last new-side line seen before the current block
	for (const line of hunk.lines) {
		if (line.kind === 'add' || line.kind === 'delete') {
			block.push(line)
			continue
		}
		ranges.push(...rangeForBlock(block, previousNewLine))
		block = []
		if (typeof line.newLine === 'number') previousNewLine = line.newLine
	}
	ranges.push(...rangeForBlock(block, previousNewLine))
	return ranges
}

// The range one block occupies: its new-side lines when it has any, else the insertion point it
// hangs off. No range at all for a block with no changed lines.
function rangeForBlock(
	block: DiffLine[],
	previousNewLine: number,
): SkimRange[] {
	if (!block.length) return []
	const newLines = block
		.map(line => line.newLine)
		.filter((newLine): newLine is number => typeof newLine === 'number')
	const stableKey = changeStableKeyFromBlock(block)
	if (!newLines.length)
		return [{ stableKey, lo: previousNewLine, hi: previousNewLine }]
	return [{ stableKey, lo: Math.min(...newLines), hi: Math.max(...newLines) }]
}

export type MovedResolution =
	| { ok: true; merged?: ResolvedMove }
	| { ok: false; reason: string }

// The restructured halves a guide-declared move produced. Returned rather than applied: the caller
// owns the live ReviewState, so the merge point stays visible at the call site.
export type ResolvedMove = { files: ReviewFile[]; changes: ChangeState[] }

// Merge guide-declared moves (GuideFile.movedFrom) into a freshly-built review: the moved-AND-edited
// case content-hash pairing (issue 02) can't catch, so the agent that made the move declares it.
// Restructures files/changes like issue 02's pairing but keyed by declaration - the merged entry is
// rename-CHANGED (contents differ), so the UI derives verdict-only, non-stageable blocks from the
// content re-diff (no server ChangeState, so /api/stage-change can't touch it). MUST run on `base`
// BEFORE mergeReviewState, so the merged entry's distinct old/new paths drive the rename migration
// (issue 01). Mirrors resolveSkim's strict/lenient contract: a NEW guide REJECTS an unresolvable
// movedFrom naming the entry; a carried-forward guide DROPS it silently (the pair falls back to
// today's delete+add - a move that no longer holds deserves fresh eyes). Working repo mode only
// (git -M covers committed renames; file mode has no untracked side).
export function resolveMovedFrom(
	state: ReviewState,
	guide: Guide,
	opts: { strict: boolean },
): MovedResolution {
	let merged: ResolvedMove = {
		files: state.files,
		changes: state.changes,
	}
	for (const file of guide.files) {
		if (!file.movedFrom) continue
		const step = mergeDeclaredMove(state, merged, file, opts.strict)
		if (!step.ok) return step
		merged = step
	}
	if (merged.files === state.files) return { ok: true }
	return { ok: true, merged }
}

type MoveStep = { ok: true } & ResolvedMove

// One declared move against the current halves: the restructured pair, or the reason a strict guide
// rejects it. Unchanged halves (`ok: true, files, changes`) when there is nothing to restructure.
function mergeDeclaredMove(
	state: ReviewState,
	merged: ResolvedMove,
	file: GuideFile,
	isStrict: boolean,
): MoveStep | { ok: false; reason: string } {
	const from = file.movedFrom ?? ''
	if (state.mode !== 'repo' || state.staged) {
		if (isStrict)
			return {
				ok: false,
				reason: `guide.files["${file.path}"].movedFrom is only supported in working repo mode`,
			}
		return { ok: true, ...merged }
	}
	// Issue 02's content-hash pairing already merged this exact (byte-identical) move - the agent
	// also declared it, redundantly. Nothing to restructure.
	if (hasMergedMove(merged.files, from, file.path))
		return { ok: true, ...merged }
	const deletion = merged.files.find(
		candidate => candidate.path === from && !candidate.newPath,
	) // full deletion (+++ /dev/null)
	const addition = merged.files.find(
		candidate =>
			candidate.path === file.path && candidate.changeKind === 'added',
	) // untracked full-file add
	if (!deletion || !addition) {
		if (isStrict)
			return {
				ok: false,
				reason: `guide.files["${file.path}"].movedFrom "${from}" did not resolve - it must name a fully deleted file paired with the untracked addition "${file.path}" in the working diff`,
			}
		return { ok: true, ...merged } // carried-forward guide whose move no longer holds → leave delete + add
	}
	// Merge into one rename-CHANGED entry at the new path (contents differ - moved AND edited). No
	// contents retained; the new-side OID is the untracked add's already-stamped contentHash, and the
	// tab fetches old (index :0 at `from`) / new (working at `to`) on open. Drop the deletion + its
	// (deletion-block) changes and the untracked entry; the merged entry carries no ChangeState
	// (blocks are UI-derived on open).
	return {
		ok: true,
		files: [
			...merged.files.filter(
				candidate => candidate !== deletion && candidate !== addition,
			),
			mergedMoveEntry(file.path, from, addition.contentHash),
		],
		changes: merged.changes.filter(change => change.path !== from),
	}
}

// The merged half of a declared move: the new path with the old one recorded, rename-CHANGED (the
// contents differ), renamePure:false so it isn't muted as a no-change move.
function mergedMoveEntry(
	to: string,
	from: string,
	contentHash: string,
): ReviewFile {
	return {
		path: to,
		oldPath: from,
		newPath: to,
		hunks: [],
		contentHash,
		changeKind: 'renamed',
		renamePure: false,
		added: 0,
		removed: 0,
	}
}

function hasMergedMove(files: ReviewFile[], from: string, to: string): boolean {
	return files.some(
		file =>
			file.path === to && file.oldPath === from && file.newPath === to,
	)
}
