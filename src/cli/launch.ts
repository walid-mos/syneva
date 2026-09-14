import { getBranch, getGitRoot } from '../git/repo.js'
import { warn } from '../output.js'
import { buildReviewState } from '../state/build.js'
import { readDeskLock } from '../state/desk.js'
import { parsedDiffOf } from '../state/diff-source.js'
import { resolveMovedFrom, resolveSkim } from '../state/guide-resolve.js'
import { loadLatestReview, persistReview } from '../state/persistence.js'
import { mergeReviewState, readStagedSnapshot } from '../state/reconcile.js'
import { maybeOfferUpdate } from '../update.js'

import { deskSession, loadGuideArg, resolveRepo } from './args.js'
import { deskAlive, postReload } from './desk-client.js'
import { serveDesk } from './desk-serve.js'
import { resolvePrTarget } from './pr-target.js'

import type { Guide, ReviewMode, ReviewState } from '../types.js'
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
	const base = await buildReviewState(repo, {
		mode,
		session,
		staged,
		path: reviewPathFilter(mode, target, args),
		target: mode === 'pr' ? prHeadTarget(pr.target, branch) : undefined,
		base: mode === 'pr' ? pr.base : undefined,
	})
	if (!base) {
		warn(noChangesMessage(mode))
		process.exitCode = 1
		return
	}
	const state = await prepareState(base, session, args)
	if (!state) return
	if (mode === 'repo') Object.assign(state, await readStagedSnapshot(state))
	Object.assign(state, (await persistReview(state)).stamp)
	await serveDesk(state, args)
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

// Merge the saved review, attach a freshly passed guide (strict) or re-resolve a carried
// forward one (lenient), and hand back the ready-to-persist state. Null aborts the launch.
async function prepareState(
	base: ReviewState,
	session: string,
	args: CliArgs,
): Promise<ReviewState | null> {
	const saved = await loadLatestReview(base.root, session)
	const newGuide = loadLaunchGuide(args)
	if (newGuide === null) return null
	// Guide-declared moves (movedFrom) must merge into `base` BEFORE reconciliation, so the
	// merged pair's distinct paths drive mergeReviewState's rename migration (issue 01). A new
	// guide resolves strictly (an unresolvable move aborts the launch); a guide carried forward
	// by a previous session resolves leniently off the saved state (the move drops back to
	// delete+add).
	const moveGuide = newGuide ?? saved?.guide
	const moved = moveGuide
		? resolveMovedFrom(base, moveGuide, { strict: !!newGuide })
		: undefined
	if (moved && !moved.ok) {
		warn(`Invalid guide: ${moved.reason}.`)
		process.exitCode = 1
		return null
	}
	// A merged move replaces the halves the rest of the launch works from; `base` itself stays the
	// object the parse was seeded on (issue 06), so it is what attachGuide hands over.
	const movedBase = moved?.merged ? { ...base, ...moved.merged } : base
	return attachGuide(await mergeReviewState(movedBase, saved), base, newGuide)
}

// Resolve the guide against the fresh diff. A newly passed guide must resolve strictly (an
// unresolvable span aborts the launch naming the offending field) and is stamped with the
// diff hash it was generated against, so a later reload past that hash flags it as possibly
// stale (slice 05). A guide carried forward by the merge (restart without --guide) resolves
// leniently - stale spans drop rather than abort. `state.rawDiff` shares identity with
// `base.rawDiff`, so the parse seeded on `base` is reused (issue 06: one parse across build +
// skim resolution). Null aborts the launch.
function attachGuide(
	state: ReviewState,
	base: ReviewState,
	newGuide: Guide | undefined,
): ReviewState | null {
	if (!newGuide) {
		if (state.guide) {
			resolveSkim(parsedDiffOf(base), state.changes, state.guide, {
				strict: false,
			})
		}
		return state
	}
	const guide: Guide = { ...newGuide, baseDiffHash: state.baseDiffHash }
	const skim = resolveSkim(parsedDiffOf(base), state.changes, guide, {
		strict: true,
	})
	if (!skim.ok) {
		warn(`Invalid guide: ${skim.reason}.`)
		process.exitCode = 1
		return null
	}
	return { ...state, guide }
}
