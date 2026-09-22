import path from 'node:path'

import { parseUnifiedDiff } from '../domain/diff/parse.js'

import { assembleDiff, fileEntry } from './diff-files.js'
import { appendUntrackedFiles } from './untracked.js'

import type { DiffFile } from '../domain/review.js'
import type { AssembledDiff } from './diff-files.js'
import type { GitPort } from './ports.js'

// Everything one build produced for a mode: the review files + change blocks and the raw diff
// they came from.
export type DiffSource = AssembledDiff & {
	rawDiff: string
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

// The branch a PR is taken against: origin's HEAD when the clone knows it, else the first of
// main/master that exists, else HEAD (a detached or unusual checkout still gets a review).
export async function resolveDefaultBranch(
	root: string,
	git: GitPort,
): Promise<string> {
	const sym = await git
		.run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)
		.catch(() => '')
	if (sym) return sym // e.g. "origin/main"
	const probed = await Promise.all(
		BRANCH_CANDIDATES.map(branch => branchExists(root, branch, git)),
	)
	const found = BRANCH_CANDIDATES.find((_, index) => probed[index])
	return found ?? 'HEAD'
}

async function branchExists(
	root: string,
	branch: string,
	git: GitPort,
): Promise<boolean> {
	return await git.run(['rev-parse', '--verify', branch], root).then(
		() => true,
		() => false,
	)
}

// The deep module: produce review files + changes for a given mode (see DiffSourceQuery).
// Returns null when the mode has nothing to review (an empty diff), which the callers turn into
// "no changes" / an empty reload.
export async function buildDiffSource(
	query: DiffSourceQuery,
	git: GitPort,
): Promise<DiffSource | null> {
	if (query.mode === 'pr') return await buildPrSource(query, git)
	if (query.mode === 'file') return await buildFileSource(query, git)
	return await buildRepoSource(query, git)
}

// pr: base..HEAD, committed on both sides, so the file-level keys come from `git diff --raw` and
// assembleDiff reads no blob contents at all.
async function buildPrSource(
	query: PrQuery,
	git: GitPort,
): Promise<DiffSource | null> {
	const base = query.base ?? 'HEAD'
	const rawDiff = await git.run(
		['diff', '--no-ext-diff', '-M', `${base}..HEAD`],
		query.root,
	)
	if (!rawDiff.trim()) return null
	const parsedDiff = parseUnifiedDiff(rawDiff)
	const assembled = await assembleDiff(parsedDiff, {
		fetchNew: p => git.fileAt(query.root, p, 'HEAD'),
		isStageable: false, // verdict-only: a commit can't be staged
		newOids: await git.rawBlobOids(query.root, { base }),
	})
	return { ...assembled, rawDiff }
}

// file: one absolute path. tracked+changed = the diff (stageable), untracked/new = the full file as
// additions, tracked-unchanged = the full file as-is.
async function buildFileSource(
	query: FileQuery,
	git: GitPort,
): Promise<DiffSource> {
	const rel = path.relative(query.root, query.path)
	const key = rel.startsWith('..') ? query.path : rel
	const tracked =
		!rel.startsWith('..') &&
		(await git
			.run(['ls-files', '--error-unmatch', '--', rel], query.root)
			.then(
				() => true,
				() => false,
			))
	const working = (await git.workspace.readFile(query.path)) ?? ''
	if (!tracked)
		return {
			files: [fileEntry(key, working, 'added')],
			changes: [],
			rawDiff: '',
		} // untracked/new → full file as additions
	const rawDiff = await git.run(
		['diff', '--no-ext-diff', '-M', '--', rel],
		query.root,
	)
	if (!rawDiff.trim())
		return {
			files: [fileEntry(key, working, 'modified')],
			changes: [],
			rawDiff: '',
		} // tracked, unchanged → full file
	// New side is the working tree - hashed locally (no committed OID). The UI re-diffs old/new
	// (fetched on open against the INDEX baseline via readFileContents), not these hunks.
	const parsedDiff = parseUnifiedDiff(rawDiff)
	const assembled = await assembleDiff(parsedDiff, {
		fetchNew: p => git.fileAt(query.root, p),
		isStageable: true,
		isWorkingSide: true,
	})
	return { ...assembled, rawDiff }
}

// repo: the working-tree diff (or the staged one under --cached), plus the untracked files git's
// diff can't see.
async function buildRepoSource(
	query: RepoQuery,
	git: GitPort,
): Promise<DiffSource | null> {
	// -M asks git itself to detect renames, so committed/staged renames render deterministically
	// regardless of the user's `diff.renames` config.
	const args = ['diff', '--no-ext-diff', '-M']
	if (query.staged) args.push('--cached')
	if (query.path) args.push('--', query.path)
	const rawDiff = await git.run(args, query.root)
	// Parse once here and reuse it for both assembleDiff and the DiffSource result (issue 06).
	const parsedDiff = rawDiff.trim() ? parseUnifiedDiff(rawDiff) : []
	const { files, changes } = await assembleRepoDiff(parsedDiff, query, git)
	if (!query.staged)
		await appendUntrackedFiles(
			files,
			changes,
			{ root: query.root, path: query.path },
			git,
		)
	if (!files.length) return null
	return { files, changes, rawDiff }
}

// Each side must match what the diff was taken against, because the UI re-diffs the old/new
// contents itself instead of rendering these hunks. Unstaged diffs working tree vs INDEX, so old
// reads :0 - a HEAD baseline would resurrect already-staged changes as pending diff on every reload.
async function assembleRepoDiff(
	parsedDiff: readonly DiffFile[],
	query: RepoQuery,
	git: GitPort,
): Promise<AssembledDiff> {
	if (!parsedDiff.length) return { files: [], changes: [] }
	return await assembleDiff(parsedDiff, {
		// Staged: the new side is the index (committed object), harvested from `git diff --raw` in one
		// process, so fetchNew is never called. Unstaged: the new side is the dirty working tree
		// (`git diff --raw` reports it as all-zeros), so fetchNew reads it to hash.
		fetchNew: p =>
			query.staged
				? git.fileAt(query.root, p, ':0')
				: git.fileAt(query.root, p),
		isStageable: true,
		newOids: query.staged
			? await git.rawBlobOids(query.root, {
					staged: true,
					path: query.path,
				})
			: undefined,
		isWorkingSide: !query.staged,
	})
}
