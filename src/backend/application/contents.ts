import path from 'node:path'

import type { FileContents } from '../domain/contents.js'
import type { ReviewFile, ReviewState } from '../domain/review.js'
import type { GitPort } from './ports.js'

// A small LRU of resolved file contents, so the tab re-opening a file (or re-fetching after a
// render) doesn't re-spawn `git show`. Keyed by root + path + contentHash: contentHash is the
// new-side blob OID, so a reload that rewrites the file changes the key and the stale entry
// falls out naturally (no explicit invalidation). Process-global - one desk per process.
const CONTENTS_CACHE_CAP = 30
const contentsCache = new Map<string, FileContents>()

// On-demand old/new contents for one reviewed file - the state carries none (issue 04). Reads git /
// the working tree, replaying the exact per-mode ref semantics buildDiffSource built the diff
// against, so a fetch returns the bytes the diff was taken over.
export async function readFileContents(
	state: ReviewState,
	file: ReviewFile,
	git: GitPort,
): Promise<FileContents> {
	const key = `${state.root}\0${file.path}\0${file.contentHash}`
	const hit = contentsCache.get(key)
	if (hit) {
		contentsCache.delete(key) // re-insert below → most-recently-used
		contentsCache.set(key, hit)
		return hit
	}
	const resolved = await resolveFileContents(state, file, git)
	contentsCache.set(key, resolved)
	evictLeastRecentlyUsed()
	return resolved
}

function resolveFileContents(
	state: ReviewState,
	file: ReviewFile,
	git: GitPort,
): Promise<FileContents> {
	if (state.mode === 'pr') return prContents(state, file, git)
	if (state.mode === 'file') return fileModeContents(state, file, git)
	return state.staged
		? stagedContents(state, file, git)
		: workingContents(state, file, git)
}

function evictLeastRecentlyUsed(): void {
	while (contentsCache.size > CONTENTS_CACHE_CAP) {
		const oldest = contentsCache.keys().next().value
		if (!oldest) break
		contentsCache.delete(oldest)
	}
}

// pr: the diff is base..HEAD, so both sides are committed objects. Read strictly, so a git object
// dropped by a mid-session rebase throws (→ /api/file-contents 404s with a reload hint) instead of
// silently serving empty. `changeKind` says which sides exist: an added file has no old side, a
// deletion no new side, so a legitimately absent side is "" WITHOUT a read.
async function prContents(
	state: ReviewState,
	file: ReviewFile,
	git: GitPort,
): Promise<FileContents> {
	const base = state.base ?? 'HEAD'
	const oldContents =
		file.changeKind === 'added'
			? ''
			: await git.fileAt(state.root, file.oldPath, base, true)
	const newContents =
		file.changeKind === 'deleted'
			? ''
			: await git.fileAt(state.root, file.newPath, 'HEAD', true)
	return { oldContents, newContents }
}

// file mode: tracked + changed reads old from the INDEX (:0) and new from the working tree
// (buildDiffSource's file-mode fetchers); tracked-unchanged is full-file working/working;
// untracked/new is ""/working. The working tree stays non-strict - a file deleted under us reads "".
async function fileModeContents(
	state: ReviewState,
	file: ReviewFile,
	git: GitPort,
): Promise<FileContents> {
	const abs = path.isAbsolute(file.path)
		? file.path
		: path.join(state.root, file.path)
	// The working read goes through the workspace facet: a file-mode target may sit outside
	// the repo, so plain fileAt's root-join doesn't apply. A vanished file reads "".
	const working = (await git.workspace.readFile(abs)) ?? ''
	const tracked = await git
		.run(['ls-files', '--error-unmatch', '--', file.path], state.root)
		.then(
			() => true,
			() => false,
		)
	if (tracked && file.hunks.length)
		return {
			oldContents: await git.fileAt(state.root, file.oldPath, ':0'),
			newContents: working,
		}
	return { oldContents: tracked ? working : '', newContents: working }
}

// staged repo diff: index vs HEAD, so both sides are committed objects read strictly.
async function stagedContents(
	state: ReviewState,
	file: ReviewFile,
	git: GitPort,
): Promise<FileContents> {
	const oldContents =
		file.changeKind === 'added'
			? ''
			: await git.fileAt(state.root, file.oldPath, 'HEAD', true)
	const newContents =
		file.changeKind === 'deleted'
			? ''
			: await git.fileAt(state.root, file.newPath, ':0', true)
	return { oldContents, newContents }
}

// working repo diff: working tree vs index. Old reads :0 (committed → strict); new reads the dirty
// working tree (non-strict → a vanished file reads ""). An untracked add is changeKind "added", so
// its old side is "" without a (failing) `:0:path` read.
async function workingContents(
	state: ReviewState,
	file: ReviewFile,
	git: GitPort,
): Promise<FileContents> {
	const oldContents =
		file.changeKind === 'added'
			? ''
			: await git.fileAt(state.root, file.oldPath, ':0', true)
	return {
		oldContents,
		newContents: await git.fileAt(state.root, file.newPath),
	}
}
