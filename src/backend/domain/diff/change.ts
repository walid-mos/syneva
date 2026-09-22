import { parseUnifiedDiff } from './parse.js'

import type { DiffFile, DiffHunk, DiffLine } from '../review.js'

const STABLE_KEY = /^(additions|deletions):(\d+):(\d+):(\d+)$/

// An absent add/delete count in a stable key leaves its size term unweighted.
const UNKNOWN_COUNT = -1

// Score pinned below any line/distance score so an exact stable-key hit always wins the sort.
const EXACT_MATCH_SCORE = -1_000_000
const SIZE_MISMATCH_WEIGHT = 10

export function changeBlocks(hunk: DiffHunk): DiffLine[][] {
	const blocks: DiffLine[][] = []
	let current: DiffLine[] = []
	for (const line of hunk.lines) {
		if (line.kind === 'add' || line.kind === 'delete') {
			current.push(line)
			continue
		}
		if (current.length) {
			blocks.push(current)
			current = []
		}
	}
	if (current.length) blocks.push(current)
	return blocks
}

export function changeStableKeyFromBlock(lines: readonly DiffLine[]): string {
	const adds = lines.filter(line => line.kind === 'add')
	const dels = lines.filter(line => line.kind === 'delete')
	const side = adds.length > 0 ? 'additions' : 'deletions'
	// First line of the block, matching the client's derivation so server-seeded
	// and client-derived change ids line up.
	const start = side === 'additions' ? adds[0]?.newLine : dels[0]?.oldLine
	const lineNumber = start ?? 0
	return `${side}:${lineNumber}:${dels.length}:${adds.length}`
}

export function changeBlockContent(lines: readonly DiffLine[]): string {
	return lines
		.map(line => `${line.kind === 'add' ? '+' : '-'}${line.text}`)
		.join('\n')
}

type ChangeAnchor = {
	side: string
	line: number
	adds: DiffLine[]
	deletes: DiffLine[]
}

function changeAnchor(block: readonly DiffLine[]): ChangeAnchor {
	const adds = block.filter(line => line.kind === 'add')
	const deletes = block.filter(line => line.kind === 'delete')
	const side = adds.length > 0 ? 'additions' : 'deletions'
	const line =
		side === 'additions'
			? (adds.at(-1)?.newLine ?? adds[0]?.newLine ?? 0)
			: (deletes.at(-1)?.oldLine ?? deletes[0]?.oldLine ?? 0)
	return { side, line, adds, deletes }
}

type RequestedChange = {
	side: string | undefined
	line: number
	deletes: number
	adds: number
}

function parseStableKey(stableKey: string): RequestedChange {
	// Capture slots are `undefined` when the key does not match, but destructuring a match
	// array types every one as `string` - the annotation keeps the fallbacks below visible as
	// real guards rather than dead code.
	const captures: (string | undefined)[] = stableKey.match(STABLE_KEY) ?? []
	const [, side, rawLine, rawDeletes, rawAdds] = captures
	return {
		side,
		line: Number(rawLine ?? 0),
		deletes: Number(rawDeletes ?? UNKNOWN_COUNT),
		adds: Number(rawAdds ?? UNKNOWN_COUNT),
	}
}

type ChangeCandidate = {
	hunk: DiffHunk
	block: readonly DiffLine[]
	score: number
}

// The best block for a stable key: an exact stable-key match always wins; otherwise the
// closest block by anchor line, tie-broken by how far the add/delete counts miss.
function findChangeCandidate(
	file: DiffFile,
	stableKey: string,
	requested: RequestedChange,
): ChangeCandidate | undefined {
	const candidates = file.hunks.flatMap(hunk =>
		changeBlocks(hunk)
			.map(block => scoreBlock(hunk, block, stableKey, requested))
			.filter(isCandidate),
	)
	return candidates.toSorted((a, b) => a.score - b.score)[0]
}

function isCandidate(
	candidate: ChangeCandidate | null,
): candidate is ChangeCandidate {
	return candidate !== null
}

function scoreBlock(
	hunk: DiffHunk,
	block: readonly DiffLine[],
	stableKey: string,
	requested: RequestedChange,
): ChangeCandidate | null {
	if (changeStableKeyFromBlock(block) === stableKey)
		return { hunk, block, score: EXACT_MATCH_SCORE }
	const anchor = changeAnchor(block)
	if (requested.side && anchor.side !== requested.side) return null
	let score = Math.abs(anchor.line - requested.line)
	if (requested.adds >= 0)
		score +=
			Math.abs(anchor.adds.length - requested.adds) * SIZE_MISMATCH_WEIGHT
	if (requested.deletes >= 0)
		score +=
			Math.abs(anchor.deletes.length - requested.deletes) *
			SIZE_MISMATCH_WEIGHT
	return { hunk, block, score }
}

export function patchForChange(
	rawDiff: string,
	filePath: string,
	stableKey: string,
): string {
	const file = parseUnifiedDiff(rawDiff).find(
		candidate => (candidate.newPath ?? candidate.oldPath) === filePath,
	)
	if (!file) throw new Error(`No diff found for ${filePath}`)
	const match = findChangeCandidate(
		file,
		stableKey,
		parseStableKey(stableKey),
	)
	if (!match)
		throw new Error(`No matching change found for ${filePath}:${stableKey}`)
	return renderPatch(filePath, match.hunk, match.block)
}

function findPreviousContext(
	lines: readonly DiffLine[],
	beforeIndex: number,
): DiffLine | undefined {
	let found: DiffLine | undefined
	for (let index = 0; index < beforeIndex; index++) {
		const candidate = lines.at(index)
		if (candidate?.kind === 'context') found = candidate
	}
	return found
}

function formatRange(start: number, count: number): string {
	return count === 1 ? String(start) : `${start},${count}`
}

function renderPatch(
	filePath: string,
	hunk: DiffHunk,
	block: readonly DiffLine[],
): string {
	const anchor = changeAnchor(block)
	const previous = findPreviousContext(
		hunk.lines,
		hunk.lines.indexOf(block[0]),
	)
	const oldStart =
		anchor.deletes[0]?.oldLine ??
		previous?.oldLine ??
		Math.max(0, (anchor.adds[0]?.newLine ?? hunk.newStart) - 1)
	const newStart =
		anchor.adds[0]?.newLine ??
		previous?.newLine ??
		Math.max(0, (anchor.deletes[0]?.oldLine ?? hunk.oldStart) - 1)
	return [
		`diff --git a/${filePath} b/${filePath}`,
		`--- a/${filePath}`,
		`+++ b/${filePath}`,
		`@@ -${formatRange(oldStart, anchor.deletes.length)} +${formatRange(newStart, anchor.adds.length)} @@`,
		...block.map(line => `${line.kind === 'add' ? '+' : '-'}${line.text}`),
		'',
	].join('\n')
}
