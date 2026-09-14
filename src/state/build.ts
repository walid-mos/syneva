import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { git } from '../git/exec.js'
import { getGitRoot, getHead } from '../git/repo.js'

import {
	buildDiffSource,
	resolveDefaultBranch,
	seedParsedDiff,
} from './diff-source.js'
import { hash, nowIso, sanitizeSession } from './identity.js'

import type { ReviewMode, ReviewState } from '../types.js'
import type { DiffSource } from './diff-source.js'

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
): Promise<ReviewState | null> {
	const mode = query.mode ?? 'repo'
	if (mode === 'file') return await buildFileReview(cwd, query)
	if (mode === 'pr') return await buildPrReview(cwd, query)
	return await buildRepoReview(cwd, query)
}

// file mode. The path may be relative to cwd; symlinks resolve (e.g. macOS /var →
// /private/var) so the path agrees with getGitRoot's realpath and relative() doesn't
// wrongly escape the repo.
async function buildFileReview(
	cwd: string,
	query: BuildQuery,
): Promise<ReviewState | null> {
	const requested = query.path ?? ''
	const resolved = path.isAbsolute(requested)
		? requested
		: path.resolve(cwd, requested)
	const abs = await fs.realpath(resolved).catch(() => resolved)
	const root = await getGitRoot(path.dirname(abs)).catch(() =>
		path.dirname(abs),
	)
	const source = await buildDiffSource({ mode: 'file', root, path: abs })
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
		head: await getHead(root),
		source,
	})
}

// pr mode: base..HEAD, base defaulting to the clone's default branch and then to its merge-base with
// HEAD (so a feature branch reviews only its own commits).
async function buildPrReview(
	cwd: string,
	query: BuildQuery,
): Promise<ReviewState | null> {
	const root = await getGitRoot(cwd)
	const defaultBranch = query.base ?? (await resolveDefaultBranch(root))
	const base = await git(['merge-base', defaultBranch, 'HEAD'], root).catch(
		() => defaultBranch,
	)
	const source = await buildDiffSource({ mode: 'pr', root, base })
	if (!source) return null
	return makeReviewState({
		mode: 'pr',
		session: query.session,
		root,
		target: query.target,
		base,
		staged: false,
		head: await getHead(root),
		source,
	})
}

async function buildRepoReview(
	cwd: string,
	query: BuildQuery,
): Promise<ReviewState | null> {
	const scope = await resolveScope(cwd, query.path)
	const source = await buildDiffSource({
		mode: 'repo',
		root: scope.root,
		path: scope.relative,
		staged: query.staged,
	})
	if (!source) return null
	return makeReviewState({
		mode: 'repo',
		session: query.session,
		root: scope.root,
		staged: !!query.staged,
		head: await getHead(scope.root),
		source,
	})
}

// The repo root a repo-mode review is built from, plus the diff limit relative to it: the scope
// directory when --path names a directory (or no --path was given), the named file's parent
// otherwise. `relative` is undefined when there is no limit.
async function resolveScope(
	cwd: string,
	diffPath: string | undefined,
): Promise<{ root: string; relative: string | undefined }> {
	if (!diffPath) return { root: await getGitRoot(cwd), relative: undefined }
	const requested = path.isAbsolute(diffPath)
		? diffPath
		: path.resolve(cwd, diffPath)
	const stat = await fs.stat(requested).catch(() => undefined)
	const discovery = stat?.isDirectory() ? requested : path.dirname(requested)
	const root = await getGitRoot(discovery)
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
	// Seed the parse memo with the DiffFile[] buildDiffSource already produced, so the reload path's
	// resolveSkim reuses it (parsedDiffOf(base)) rather than re-parsing rawDiff (issue 06).
	seedParsedDiff(state, source.parsedDiff)
	return state
}
