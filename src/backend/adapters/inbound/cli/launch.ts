import { buildReviewState } from '../../../application/build.js'
import {
	mergeReviewState,
	readStagedSnapshot,
} from '../../../application/reconcile.js'
import { warn } from '../../outbound/console.js'
import { readDeskLock } from '../../outbound/filesystem/desk.js'
import { nodeReviewStore } from '../../outbound/filesystem/persistence.js'
import { getBranch, getGitRoot, nodeGit } from '../../outbound/git/repo.js'
import { maybeOfferUpdate } from '../../outbound/package-registry/update.js'

import { deskSession, loadGuideArg, resolveRepo } from './args.js'
import { deskAlive, postReload } from './desk-client.js'
import { serveDesk } from './desk-serve.js'
import { resolvePrTarget } from './pr-target.js'

import type { Guide, ReviewMode } from '../../../../contracts/review.js'
import type { ReviewState } from '../../../domain/review.js'
import type { CliArgs } from './args.js'

// Launch a persistent desk in repo / file / pr mode.
export async function runDesk(
	mode: ReviewMode,
	target: string | undefined,
	args: CliArgs,
): Promise<void> {
	// Desk starts only - the agent subcommands must never block on a prompt. On a
	// confirmed update this re-execs the new version with the same args and never returns.
	await maybeOfferUpdate()
	const repo = resolveRepo(args)
	const staged = args.diff === 'staged' || args.staged === true
	const root = await getGitRoot(repo).catch(() => repo)
	const branch = (await getBranch(root)) || ''
	const pr = await resolvePrTarget(mode, target, args, root)
	if (!pr) return
	const session = deskSession(
		mode,
		pr.target,
		branch,
		typeof args.session === 'string' ? args.session : undefined,
	)
	// Idempotent start: a live desk for this repo+session is reused - reload the diff
	// (and swap the guide, if one was passed) into the open tab instead of opening a
	// second desk on a new port. Use --session/--port for a genuinely separate desk.
	if (await reloadLiveDesk(root, session, args)) return
	const base = await buildReviewState(
		repo,
		{
			mode,
			session,
			staged,
			path: reviewPathFilter(mode, target, args),
			target: mode === 'pr' ? prHeadTarget(pr.target, branch) : undefined,
			base: mode === 'pr' ? pr.base : undefined,
		},
		nodeGit,
	)
	if (!base) {
		warn(noChangesMessage(mode))
		process.exitCode = 1
		return
	}
	const state = await prepareState(base, session, args)
	if (!state) return
	// Publish the construction-time merges as one immutable root: the staged snapshot (repo
	// mode) and the persist stamp fold into the root the desk serves from then on.
	let live = state
	if (mode === 'repo')
		live = { ...live, ...(await readStagedSnapshot(live, nodeGit)) }
	const persisted = await nodeReviewStore.persistReview(live)
	await serveDesk({ ...live, ...persisted.stamp }, args)
}

// The PR head the review is taken against: the resolved target when one was given, else the
// checked-out branch.
function prHeadTarget(target: string | undefined, branch: string): string {
	if (target) return target
	return branch
}

function reviewPathFilter(
	mode: ReviewMode,
	target: string | undefined,
	args: CliArgs,
): string | undefined {
	if (mode === 'file') return target
	if (mode === 'repo' && typeof args.path === 'string') return args.path
	return undefined
}

function noChangesMessage(mode: ReviewMode): string {
	if (mode === 'pr')
		return 'No PR changes to review (branch matches its base).'
	if (mode === 'file') return 'File not found or unreadable.'
	return 'No git diff found to review.'
}

// Reuse a live desk for this repo+session instead of opening a second one. Returns true when
// the caller should stop (the reload was handled, or a bad --guide aborted the launch).
async function reloadLiveDesk(
	root: string,
	session: string,
	args: CliArgs,
): Promise<boolean> {
	const lock = await readDeskLock(root, session)
	if (!lock || !(await deskAlive(lock.url))) return false
	const guide = loadLaunchGuide(args)
	if (guide === null) return true
	const response = await postReload(lock.url, guide)
	if (response.ok) {
		warn(
			`Desk already live for session "${session}" - reloaded${guide ? ' with the new guide' : ''} in the open tab: ${lock.url}`,
		)
		return true
	}
	warn('Live desk did not accept the reload - starting a fresh one.')
	return false
}

// Validate the launch's --guide file. `null` means the flag was unusable - the reason is
// already on stderr and the caller must abort without touching the desk.
function loadLaunchGuide(args: CliArgs): Guide | undefined | null {
	const guide = loadGuideArg(args.guide)
	if (guide === null) process.exitCode = 1
	return guide
}

// Merge the saved review and attach a freshly passed guide. A guide the merge carried forward
// (mergeReviewState keeps saved.guide) needs no further work - and nothing in a guide needs
// resolving against the diff any more, so a bad one can no longer abort beyond the schema check.
// Null aborts the launch.
async function prepareState(
	base: ReviewState,
	session: string,
	args: CliArgs,
): Promise<ReviewState | null> {
	const saved = await nodeReviewStore.loadLatestReview(base.root, session)
	const newGuide = loadLaunchGuide(args)
	if (newGuide === null) return null
	const state = await mergeReviewState(base, saved, nodeGit)
	if (!newGuide) return state
	// Stamp the diff the grouping was generated against: once a reload advances past it the desk
	// notes the grouping may be out of date (Guide.baseDiffHash).
	return {
		...state,
		guide: { ...newGuide, baseDiffHash: state.baseDiffHash },
	}
}
