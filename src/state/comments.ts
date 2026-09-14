import crypto from 'node:crypto'

import { anchorTextFor, readFileContents } from './contents.js'
import { nowIso } from './identity.js'
import { loadLatestReview, persistReview } from './persistence.js'

import type { ReviewComment } from '../types.js'
import type { FileContents } from './contents.js'

// The Dice coefficient weights the shared bigrams twice: 2|A∩B| / (|A| + |B|).
const DICE_PAIR_WEIGHT = 2

// Character-bigram width for the similarity metric, and the two thresholds that decide when a
// lightly-edited line is still "the same" line: >= floor to be a candidate at all, and within the
// tie window the candidate nearest the old position wins.
const BIGRAM_WIDTH = 2
const SIMILARITY_FLOOR = 0.6
const SIMILARITY_TIE = 0.05

// The reviewer's fields of a new comment, as posted by `galley comment` / the UI composer.
export type CommentInput = {
	path: string
	side: 'additions' | 'deletions'
	lineNumber: number
	body: string
	role: 'user' | 'agent'
}

// Append a comment to the persisted review, capturing the anchor text of the line it points at so a
// later reload can re-anchor the thread (see reanchorComments).
export async function appendComment(
	root: string,
	session: string,
	input: CommentInput,
): Promise<ReviewComment> {
	const saved = await loadLatestReview(root, session)
	if (!saved)
		throw new Error(
			`No saved review for session "${session}" in ${root}. Open the desk first.`,
		)
	// Fetch just this file's contents (the state embeds none) to capture the anchor line.
	const file = saved.files.find(candidate => candidate.path === input.path)
	const contents = file ? await readFileContents(saved, file) : undefined
	const now = nowIso()
	const comment: ReviewComment = {
		id: crypto.randomUUID(),
		path: input.path,
		side: input.side,
		lineNumber: input.lineNumber,
		body: input.body,
		createdAt: now,
		updatedAt: now,
		status: 'open',
		intent: 'note',
		role: input.role,
		anchorText: anchorTextFor(contents, input.side, input.lineNumber),
	}
	saved.comments.push(comment)
	await persistReview(saved)
	return comment
}

// Recover comment anchors after the diff is rebuilt. Open comments only (resolved threads
// are done - they only render if their line still does). Exact text at the recorded line →
// anchored; else the unique nearest line with exactly that text → move the anchor there; else a
// best-effort fuzzy match keeps a lightly-edited line's thread near its old spot; only when
// nothing is similar enough do we flag `unanchored` so the desk shows the thread in its
// file-level strip rather than silently dropping it (an open change request blocks approval, so
// it must stay reachable). Legacy comments without anchorText can only be flagged when their
// line is provably out of range.
//
// `contentsOf` resolves a present file's on-demand contents (the state no longer embeds them). The
// caller fetches only the files carrying an open comment - the same set this processes - so a file
// with no resolved contents is treated as empty (matching a missing embedded side before issue 04).
export function reanchorComments(
	comments: ReviewComment[],
	files: { path: string }[],
	contentsOf: (path: string) => FileContents | undefined,
): ReviewComment[] {
	return comments.map(comment => reanchorComment(comment, files, contentsOf))
}

// One comment anchored onto the file's current contents. Returns the same record when there is
// nothing to recover (resolved threads are done - they only render if their line still does - and a
// vanished file is the caller's staleness call), else a re-anchored copy.
function reanchorComment(
	comment: ReviewComment,
	files: { path: string }[],
	contentsOf: (path: string) => FileContents | undefined,
): ReviewComment {
	if (comment.status !== 'open') return comment
	const file = files.find(candidate => candidate.path === comment.path)
	if (!file) return comment
	return withRecoveredAnchor(comment, contentsOf(comment.path))
}

function withRecoveredAnchor(
	comment: ReviewComment,
	contents: FileContents | undefined,
): ReviewComment {
	const text =
		comment.side === 'deletions'
			? contents?.oldContents
			: contents?.newContents
	const lines = (text ?? '').split('\n')
	if (!comment.anchorText)
		return {
			...comment,
			unanchored: comment.lineNumber > lines.length,
		}
	if (lines[comment.lineNumber - 1] === comment.anchorText)
		return { ...comment, unanchored: false }
	const best = bestAnchorLine(lines, comment.anchorText, comment.lineNumber)
	// An all-whitespace anchor is too thin to re-anchor (nearestSimilarLine refuses it) and a missing
	// match means the line is gone: either way the thread detaches rather than guessing. Line numbers
	// are 1-based, so a falsy best is "none".
	if (!best || !comment.anchorText.trim())
		return { ...comment, unanchored: true }
	return shiftedAnchor(comment, best)
}

// The comment moved from its old line to `best`, carrying a multi-line anchor's end line with it.
function shiftedAnchor(comment: ReviewComment, best: number): ReviewComment {
	const delta = best - comment.lineNumber
	if (typeof comment.endLine !== 'number')
		return { ...comment, lineNumber: best, unanchored: false }
	return {
		...comment,
		lineNumber: best,
		endLine: comment.endLine + delta,
		unanchored: false,
	}
}

// The 1-based line an anchor should move to: the only exact match, the unambiguous nearest of
// several, or wherever the anchor's text most nearly survives.
function bestAnchorLine(
	lines: string[],
	anchorText: string,
	oldLine: number,
): number | undefined {
	const matches = matchingLines(lines, anchorText)
	if (matches.length === 1) return matches[0]
	if (matches.length > 1) return unambiguousNearest(matches, oldLine)
	return nearestSimilarLine(lines, anchorText, oldLine)
}

function matchingLines(lines: string[], anchorText: string): number[] {
	const matches: number[] = []
	for (const [index, line] of lines.entries()) {
		if (line === anchorText) matches.push(index + 1)
	}
	return matches
}

// The nearest exact match, or undefined on a tie: the text still exists verbatim, just in more than
// one equally-near place - don't guess.
function unambiguousNearest(
	matches: number[],
	oldLine: number,
): number | undefined {
	const [closest, runnerUp] = matches.toSorted(
		(a, b) => Math.abs(a - oldLine) - Math.abs(b - oldLine),
	)
	if (Math.abs(closest - oldLine) === Math.abs(runnerUp - oldLine))
		return undefined
	return closest
}

// Best-effort fallback when a comment's anchor text no longer appears verbatim: the most similar
// surviving line (Dice ≥ SIMILARITY_FLOOR), preferring the closest to the old position on a near-tie.
// Returns the 1-based line, or undefined when nothing is similar enough (then the thread detaches
// cleanly).
function nearestSimilarLine(
	lines: string[],
	anchorText: string,
	oldLine: number,
): number | undefined {
	if (anchorText.trim() === '') return undefined
	let best: { line: number; sim: number } | undefined
	for (const [index, line] of lines.entries()) {
		const candidate = {
			line: index + 1,
			sim: lineSimilarity(line, anchorText),
		}
		if (candidate.sim < SIMILARITY_FLOOR) continue
		if (isBetterMatch(candidate, best, oldLine)) best = candidate
	}
	return best?.line
}

// A higher score wins outright; inside the tie window the line nearer the old position wins.
function isBetterMatch(
	candidate: { line: number; sim: number },
	best: { line: number; sim: number } | undefined,
	oldLine: number,
): boolean {
	if (!best) return true
	if (candidate.sim > best.sim + SIMILARITY_TIE) return true
	if (Math.abs(candidate.sim - best.sim) > SIMILARITY_TIE) return false
	return Math.abs(candidate.line - oldLine) < Math.abs(best.line - oldLine)
}

// Sørensen-Dice similarity on character bigrams (whitespace-normalized), 0..1. Cheap and good at
// "same line, lightly edited" - the case a comment loses its exact anchor to.
function lineSimilarity(a: string, b: string): number {
	const left = normalizeLine(a)
	const right = normalizeLine(b)
	if (left === right) return 1
	if (left.length < BIGRAM_WIDTH || right.length < BIGRAM_WIDTH) return 0
	const leftGrams = bigramCounts(left)
	const rightGrams = bigramCounts(right)
	let shared = 0
	for (const [gram, count] of leftGrams) {
		const other = rightGrams.get(gram)
		if (other) shared += Math.min(count, other)
	}
	const total = left.length - 1 + (right.length - 1)
	return total > 0 ? (DICE_PAIR_WEIGHT * shared) / total : 0
}

function normalizeLine(line: string): string {
	return line.trim().replace(/\s+/g, ' ')
}

// Character-bigram histogram of a normalized line.
function bigramCounts(line: string): Map<string, number> {
	const counts = new Map<string, number>()
	for (let index = 0; index < line.length - 1; index++) {
		const gram = line.slice(index, index + BIGRAM_WIDTH)
		counts.set(gram, (counts.get(gram) ?? 0) + 1)
	}
	return counts
}
