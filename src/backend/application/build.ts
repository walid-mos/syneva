import crypto from 'node:crypto'
import path from 'node:path'

import { hash, sanitizeSession } from '../domain/identity.js'

import { buildDiffSource, resolveDefaultBranch } from './diff-source.js'
import { nowIso } from './time.js'

import type { ReviewMode, ReviewState } from '../domain/review.js'
import type { DiffSource } from './diff-source.js'
import type { GitPort } from './ports.js'

// The parameters of a desk start: what to review (mode + path/base/target) and under which session.
export type BuildQuery = {
	mode?: ReviewMode
	path?: string
	staged?: boolean
	session: string
	target?: string
	base?: string
}

// Build a fresh review for a mode:
// repo  → the working/staged diff (query.path is a root-relative limit),
// file  → one file (query.path, absolute or relative to cwd),
// pr    → base..HEAD (committed), verdict-only.
// Returns null when there is nothing to review.
export async function buildReviewState(
	cwd: string,
	query: BuildQuery,
	git: GitPort,
): Promise<ReviewState | null> {
	const mode = query.mode ?? 'repo'
	if (mode === 'file') return await buildFileReview(cwd, query, git)
	if (mode === 'pr') return await buildPrReview(cwd, query, git)
	return await buildRepoReview(cwd, query, git)
}

// file mode. The path may be relative to cwd; symlinks resolve (e.g. macOS /var →
// /private/var) so the path agrees with getGitRoot's realpath and relative() doesn't
// wrongly escape the repo.
async function buildFileReview(
	cwd: string,
	query: BuildQuery,
	git: GitPort,
): Promise<ReviewState | null> {
	const requested = query.path ?? ''
	const resolved = path.isAbsolute(requested)
		? requested
		: path.resolve(cwd, requested)
	// Symlinks resolve (e.g. macOS /var → /private/var) so the path agrees with getGitRoot's
	// realpath and relative() doesn't wrongly escape the repo; an unresolvable path keeps the
	// input and lets git-root discovery fall back below.
	const abs = (await git.workspace.realpath(resolved)) ?? resolved
	const root = await git
		.getGitRoot(path.dirname(abs))
		.catch(() => path.dirname(abs))
	const source = await buildDiffSource({ mode: 'file', root, path: abs }, git)
	if (!source) return null
	const relative = path.relative(root, abs)
	return makeReviewState({
		mode: 'file',
		session: query.session,
		root,
		// The target a reload rebuilds from: the repo-relative path, or the absolute one when the
		// file sits outside the repo.
		target: relative.startsWith('..') ? abs : relative,
		staged: false,
		head: await git.getHead(root),
		source,
	})
}

// pr mode: base..HEAD, base defaulting to the clone's default branch and then to its merge-base with
// HEAD (so a feature branch reviews only its own commits).
async function buildPrReview(
	cwd: string,
	query: BuildQuery,
	git: GitPort,
): Promise<ReviewState | null> {
	const root = await git.getGitRoot(cwd)
	const defaultBranch = query.base ?? (await resolveDefaultBranch(root, git))
	const base = await git
		.run(['merge-base', defaultBranch, 'HEAD'], root)
		.catch(() => defaultBranch)
	const source = await buildDiffSource({ mode: 'pr', root, base }, git)
	if (!source) return null
	return makeReviewState({
		mode: 'pr',
		session: query.session,
		root,
		target: query.target,
		base,
		staged: false,
		head: await git.getHead(root),
		source,
	})
}

async function buildRepoReview(
	cwd: string,
	query: BuildQuery,
	git: GitPort,
): Promise<ReviewState | null> {
	const scope = await resolveScope(cwd, query.path, git)
	const source = await buildDiffSource(
		{
			mode: 'repo',
			root: scope.root,
			path: scope.relative,
			staged: query.staged,
		},
		git,
	)
	if (!source) return null
	return makeReviewState({
		mode: 'repo',
		session: query.session,
		root: scope.root,
		staged: !!query.staged,
		head: await git.getHead(scope.root),
		source,
	})
}

// The repo root a repo-mode review is built from, plus the diff limit relative to it: the scope
// directory when --path names a directory (or no --path was given), the named file's parent
// otherwise. `relative` is undefined when there is no limit.
async function resolveScope(
	cwd: string,
	diffPath: string | undefined,
	git: GitPort,
): Promise<{ root: string; relative: string | undefined }> {
	if (!diffPath)
		return { root: await git.getGitRoot(cwd), relative: undefined }
	const requested = path.isAbsolute(diffPath)
		? diffPath
		: path.resolve(cwd, diffPath)
	const isDir = await git.workspace.isDirectory(requested)
	const discovery = isDir ? requested : path.dirname(requested)
	const root = await git.getGitRoot(discovery)
	return { root, relative: path.relative(root, requested) }
}

function makeReviewState(input: {
	mode: ReviewMode
	session: string
	root: string
	staged: boolean
	head: string | null
	source: DiffSource
	target?: string
	base?: string
}): ReviewState {
	const { source } = input
	const state: ReviewState = {
		id: crypto.randomUUID(),
		session: sanitizeSession(input.session),
		root: input.root,
		repoHash: hash(input.root),
		mode: input.mode,
		target: input.target,
		base: input.base,
		staged: input.staged,
		head: input.head,
		baseDiffHash: hash(source.rawDiff),
		createdAt: nowIso(),
		updatedAt: nowIso(),
		rawDiff: source.rawDiff,
		files: source.files,
		comments: [],
		changes: source.changes,
		reviewedFiles: [],
		reviewedFileHashes: {},
		stagedFiles: [],
		decisions: [],
	}
	return state
}
