import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { patchForChange } from '../git/change.js'
import { git } from '../git/exec.js'

import { errorMessage } from './failure.js'

import type { ReviewState } from '../types.js'

export type StagePathsRequest = { paths: string[]; recorded?: string }

export type StageChangeRequest = { path: string; stableKey: string }

export type StageChangeOutcome =
	| { decision: 'already-staged'; skipped: true }
	| { decision: 'staged'; skipped: boolean; stagedChangeKeys: string[] }
	| { decision: 'conflict'; skipped: false; message: string }

// `{ path }` stages one file (back-compat); `{ paths }` stages several in one `git add` - used for a
// working-mode move pair, where `git add`-ing both the old (deleted) and new path records the rename
// in the index. Returns the stagedFiles patch to merge (empty when the recorded path is already there);
// stagedFiles records the review file's path once: the caller's `path`, else the last of `paths`
// (approveCurrentFile sends [old, new]).
export async function stagePaths(
	state: ReviewState,
	request: StagePathsRequest,
): Promise<Partial<ReviewState>> {
	if (request.paths.length)
		await git(['add', '--', ...request.paths], state.root)
	const recorded = request.recorded ?? request.paths.at(-1)
	if (!recorded || state.stagedFiles.includes(recorded)) return {}
	return { stagedFiles: [...state.stagedFiles, recorded] }
}

// Stage one change block by applying a patch rebuilt from the parsed diff onto the index. The
// recorded key is what makes staging idempotent: a block already staged (e.g. the reviewer reloaded
// and accepted it again) is a no-op, not a double-apply.
export async function stageChange(
	state: ReviewState,
	request: StageChangeRequest,
): Promise<StageChangeOutcome> {
	const key = `${request.path}:${request.stableKey}`
	const staged = state.stagedChangeKeys ?? []
	if (staged.includes(key))
		return { decision: 'already-staged', skipped: true }
	let applied: 'applied' | 'skipped'
	try {
		applied = await applyPatchToIndex(
			state.root,
			patchForChange(state.rawDiff, request.path, request.stableKey),
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
		stagedChangeKeys: [...staged, key],
	}
}

// Unstage one file and forget its recorded change keys. Returns the patch to merge.
export async function unstagePath(
	state: ReviewState,
	filePath: string,
): Promise<Partial<ReviewState>> {
	await git(['restore', '--staged', '--', filePath], state.root).catch(
		async () => git(['reset', 'HEAD', '--', filePath], state.root),
	)
	return {
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
async function applyPatchToIndex(
	root: string,
	patch: string,
): Promise<'applied' | 'skipped'> {
	const tmp = path.join(
		// os.tmpdir(), not $TMPDIR-or-/tmp: Windows sets TEMP/TMP instead, so the old fallback
		// resolved to a nonexistent C:\tmp and mkdtemp ENOENT'd - hunk staging failed there.
		await fs.mkdtemp(path.join(os.tmpdir(), 'galley-')),
		`${crypto.randomUUID()}.diff`,
	)
	await fs.writeFile(tmp, patch, 'utf8')
	try {
		const baseArgs = ['apply', '--cached', '--unidiff-zero']
		const alreadyApplied = await git(
			[...baseArgs, '--reverse', '--check', tmp],
			root,
		).then(
			() => true,
			() => false,
		)
		if (alreadyApplied) return 'skipped'
		await git([...baseArgs, tmp], root)
		return 'applied'
	} finally {
		await fs
			.rm(path.dirname(tmp), { recursive: true, force: true })
			.catch(() => undefined)
	}
}
