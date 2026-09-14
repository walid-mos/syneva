import { promises as fs } from 'node:fs'
import path from 'node:path'

import { git } from '../git/exec.js'
import { parseUnifiedDiff } from '../git/parse.js'
import { fileAt, rawBlobOids } from '../git/repo.js'

import { assembleDiff, fileEntry } from './diff-files.js'
import { appendUntrackedFiles } from './untracked.js'

import type { DiffFile, ReviewState } from '../types.js'
import type { AssembledDiff } from './diff-files.js'

// Everything one build produced for a mode: the review files + change blocks, the raw diff they
// came from, and its parse (see parsedDiffOf).
export type DiffSource = AssembledDiff & {
	rawDiff: string
	parsedDiff: DiffFile[]
}

// What to build, per mode: repo → the working/staged diff (path is a root-relative limit);
// file → one file (an absolute path); pr → base..HEAD (committed), verdict-only.
export type DiffSourceQuery =
	| { mode: 'pr'; root: string; base?: string }
	| { mode: 'file'; root: string; path: string }
	| { mode: 'repo'; root: string; path?: string; staged?: boolean }

type PrQuery = Extract<DiffSourceQuery, { mode: 'pr' }>
type FileQuery = Extract<DiffSourceQuery, { mode: 'file' }>
type RepoQuery = Extract<DiffSourceQuery, { mode: 'repo' }>

// Branches a clone's default branch falls back to when origin/HEAD isn't set.
const BRANCH_CANDIDATES = ['main', 'master'] as const

// The parse of a state's rawDiff, computed once and memoized against the state object (GC-tied to
// it - not a growing module cache). buildReviewState seeds it with the exact DiffFile[] assembleDiff
// produced during the build, so the reload path's resolveSkim reuses that parse rather than parsing
// the same (multi-MB) rawDiff a second time. A caller holding a state built elsewhere - or reloaded
// from disk - falls back to parsing on first access. Same DiffFile[] either way: behavior identical.
const parsedDiffCache = new WeakMap<ReviewState, DiffFile[]>()

export function parsedDiffOf(state: ReviewState): DiffFile[] {
	let hit = parsedDiffCache.get(state)
	if (!hit) {
		hit = parseUnifiedDiff(state.rawDiff)
		parsedDiffCache.set(state, hit)
	}
	return hit
}

// Tie an already-computed parse to a state so the reload path reuses it instead of re-parsing
// rawDiff (issue 06). Called by buildReviewState with the parse its own build produced.
export function seedParsedDiff(state: ReviewState, parsed: DiffFile[]): void {
	parsedDiffCache.set(state, parsed)
}

// The branch a PR is taken against: origin's HEAD when the clone knows it, else the first of
// main/master that exists, else HEAD (a detached or unusual checkout still gets a review).
export async function resolveDefaultBranch(root: string): Promise<string> {
	const sym = await git(
		['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
		root,
	).catch(() => '')
	if (sym) return sym // e.g. "origin/main"
	const probed = await Promise.all(
		BRANCH_CANDIDATES.map(branch => branchExists(root, branch)),
	)
	const found = BRANCH_CANDIDATES.find((_, index) => probed[index])
	return found ?? 'HEAD'
}

async function branchExists(root: string, branch: string): Promise<boolean> {
	return await git(['rev-parse', '--verify', branch], root).then(
		() => true,
		() => false,
	)
}

// The deep module: produce review files + changes for a given mode (see DiffSourceQuery).
// Returns null when the mode has nothing to review (an empty diff), which the callers turn into
// "no changes" / an empty reload.
export async function buildDiffSource(
	query: DiffSourceQuery,
): Promise<DiffSource | null> {
	if (query.mode === 'pr') return await buildPrSource(query)
	if (query.mode === 'file') return await buildFileSource(query)
	return await buildRepoSource(query)
}

// pr: base..HEAD, committed on both sides, so the file-level keys come from `git diff --raw` and
// assembleDiff reads no blob contents at all.
async function buildPrSource(query: PrQuery): Promise<DiffSource | null> {
	const base = query.base ?? 'HEAD'
	const rawDiff = await git(
		['diff', '--no-ext-diff', '-M', `${base}..HEAD`],
		query.root,
	)
	if (!rawDiff.trim()) return null
	const parsedDiff = parseUnifiedDiff(rawDiff)
	const assembled = await assembleDiff(parsedDiff, {
		fetchNew: p => fileAt(query.root, p, 'HEAD'),
		isStageable: false, // verdict-only: a commit can't be staged
		newOids: await rawBlobOids(query.root, { base }),
	})
	return { ...assembled, rawDiff, parsedDiff }
}

// file: one absolute path. tracked+changed = the diff (stageable), untracked/new = the full file as
// additions, tracked-unchanged = the full file as-is.
async function buildFileSource(query: FileQuery): Promise<DiffSource> {
	const rel = path.relative(query.root, query.path)
	const key = rel.startsWith('..') ? query.path : rel
	const tracked =
		!rel.startsWith('..') &&
		(await git(['ls-files', '--error-unmatch', '--', rel], query.root).then(
			() => true,
			() => false,
		))
	const working = await fs.readFile(query.path, 'utf8').catch(() => '')
	if (!tracked)
		return {
			files: [fileEntry(key, '', working)],
			changes: [],
			rawDiff: '',
			parsedDiff: [],
		} // untracked/new → full file as additions
	const rawDiff = await git(
		['diff', '--no-ext-diff', '-M', '--', rel],
		query.root,
	)
	if (!rawDiff.trim())
		return {
			files: [fileEntry(key, working, working)],
			changes: [],
			rawDiff: '',
			parsedDiff: [],
		} // tracked, unchanged → full file
	// New side is the working tree - hashed locally (no committed OID). The UI re-diffs old/new
	// (fetched on open against the INDEX baseline via readFileContents), not these hunks.
	const parsedDiff = parseUnifiedDiff(rawDiff)
	const assembled = await assembleDiff(parsedDiff, {
		fetchNew: p => fileAt(query.root, p),
		isStageable: true,
		isWorkingSide: true,
	})
	return { ...assembled, rawDiff, parsedDiff }
}

// repo: the working-tree diff (or the staged one under --cached), plus the untracked files git's
// diff can't see.
async function buildRepoSource(query: RepoQuery): Promise<DiffSource | null> {
	// -M asks git itself to detect renames, so committed/staged renames render deterministically
	// regardless of the user's `diff.renames` config.
	const args = ['diff', '--no-ext-diff', '-M']
	if (query.staged) args.push('--cached')
	if (query.path) args.push('--', query.path)
	const rawDiff = await git(args, query.root)
	// Parse once here and reuse it for both assembleDiff and the DiffSource result (issue 06).
	const parsedDiff = rawDiff.trim() ? parseUnifiedDiff(rawDiff) : []
	const { files, changes } = await assembleRepoDiff(parsedDiff, query)
	if (!query.staged)
		await appendUntrackedFiles(files, changes, {
			root: query.root,
			path: query.path,
		})
	if (!files.length) return null
	return { files, changes, rawDiff, parsedDiff }
}

// Each side must match what the diff was taken against, because the UI re-diffs the old/new
// contents itself instead of rendering these hunks. Unstaged diffs working tree vs INDEX, so old
// reads :0 - a HEAD baseline would resurrect already-staged changes as pending diff on every reload.
async function assembleRepoDiff(
	parsedDiff: DiffFile[],
	query: RepoQuery,
): Promise<AssembledDiff> {
	if (!parsedDiff.length) return { files: [], changes: [] }
	return await assembleDiff(parsedDiff, {
		// Staged: the new side is the index (committed object), harvested from `git diff --raw` in one
		// process, so fetchNew is never called. Unstaged: the new side is the dirty working tree
		// (`git diff --raw` reports it as all-zeros), so fetchNew reads it to hash.
		fetchNew: p =>
			query.staged ? fileAt(query.root, p, ':0') : fileAt(query.root, p),
		isStageable: true,
		newOids: query.staged
			? await rawBlobOids(query.root, { staged: true, path: query.path })
			: undefined,
		isWorkingSide: !query.staged,
	})
}
