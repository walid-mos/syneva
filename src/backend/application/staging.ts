import path from 'node:path'

import { patchForChange } from '../domain/diff/change.js'

import { errorMessage } from './errors.js'

import type { ReviewState } from '../domain/review.js'
import type { GitPort } from './ports.js'

export type StagePathsRequest = { paths: string[]; recorded?: string }

export type StageChangeRequest = { path: string; stableKey: string }

export type StageChangeOutcome =
	| { decision: 'already-staged'; skipped: true; state: ReviewState }
	| { decision: 'staged'; skipped: boolean; state: ReviewState }
	| { decision: 'conflict'; skipped: false; message: string }

// `{ path }` stages one file (back-compat); `{ paths }` stages several in one `git add` - used for a
// working-mode move pair, where `git add`-ing both the old (deleted) and new path records the rename
// in the index. Returns the next state root with the stagedFiles branch replaced (the same root when
// nothing changed): stagedFiles records the review file's path once - the caller's `path`, else the
// last of `paths` (approveCurrentFile sends [old, new]).
export async function stagePaths(
	state: ReviewState,
	request: StagePathsRequest,
	git: GitPort,
): Promise<ReviewState> {
	if (request.paths.length)
		await git.run(['add', '--', ...request.paths], state.root)
	const recorded = request.recorded ?? request.paths.at(-1)
	if (!recorded || state.stagedFiles.includes(recorded)) return state
	return { ...state, stagedFiles: [...state.stagedFiles, recorded] }
}

// Stage one change block by applying a patch rebuilt from the parsed diff onto the index. The
// recorded key is what makes staging idempotent: a block already staged (e.g. the reviewer reloaded
// and accepted it again) is a no-op, not a double-apply.
export async function stageChange(
	state: ReviewState,
	request: StageChangeRequest,
	git: GitPort,
): Promise<StageChangeOutcome> {
	const key = `${request.path}:${request.stableKey}`
	const staged = state.stagedChangeKeys ?? []
	if (staged.includes(key))
		return { decision: 'already-staged', skipped: true, state }
	let applied: 'applied' | 'skipped'
	try {
		applied = await applyPatchToIndex(
			state.root,
			patchForChange(state.rawDiff, request.path, request.stableKey),
			git,
		)
	} catch (error) {
		return {
			decision: 'conflict',
			skipped: false,
			message: errorMessage(error),
		}
	}
	return {
		decision: 'staged',
		skipped: applied === 'skipped',
		state: { ...state, stagedChangeKeys: [...staged, key] },
	}
}

// Unstage one file and forget its recorded change keys. Returns the next state root with both
// staged branches replaced.
export async function unstagePath(
	state: ReviewState,
	filePath: string,
	git: GitPort,
): Promise<ReviewState> {
	await git
		.run(['restore', '--staged', '--', filePath], state.root)
		.catch(async () =>
			git.run(['reset', 'HEAD', '--', filePath], state.root),
		)
	return {
		...state,
		stagedFiles: state.stagedFiles.filter(
			candidate => candidate !== filePath,
		),
		stagedChangeKeys: (state.stagedChangeKeys ?? []).filter(
			key => !key.startsWith(`${filePath}:`),
		),
	}
}

// Apply a patch to the git index, reporting whether it changed anything. A reverse `--check` first
// tells "already staged" (a reload re-accepting a block the index already holds) from a real apply.
// The patch travels through a temp file the workspace port provides - the application layer
// never touches the filesystem itself.
async function applyPatchToIndex(
	root: string,
	patch: string,
	git: GitPort,
): Promise<'applied' | 'skipped'> {
	const tmp = await git.workspace.writeTempFile(patch)
	try {
		const baseArgs = ['apply', '--cached', '--unidiff-zero']
		const alreadyApplied = await git
			.run([...baseArgs, '--reverse', '--check', tmp], root)
			.then(
				() => true,
				() => false,
			)
		if (alreadyApplied) return 'skipped'
		await git.run([...baseArgs, tmp], root)
		return 'applied'
	} finally {
		await git.workspace.removeTempDir(path.dirname(tmp))
	}
}
