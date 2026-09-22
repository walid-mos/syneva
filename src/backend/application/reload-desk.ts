import { validateGuide } from '../domain/guide.js'
import { hash } from '../domain/identity.js'

import { buildReviewState } from './build.js'
import { mergeReviewState, readStagedSnapshot } from './reconcile.js'

import type { Guide, ReviewState } from '../domain/review.js'
import type { GitPort, ReviewStorePort } from './ports.js'

// The reload's collaborator ports: git (rebuild + reconcile) and the review store (persist).
export type ReloadIo = { git: GitPort; store: ReviewStorePort }

export type ReloadOutcome =
	| { kind: 'reloaded'; state: ReviewState; baseDiffHash: string }
	| { kind: 'empty'; state: ReviewState; baseDiffHash: string }
	| { kind: 'invalid-guide'; reason: string }

// Re-diff the review into a NEW state root so the open desk reflects the agent's edits without
// a restart. Rebuilds using the stored mode params; an optional { guide } in the body swaps the
// attached guide in the same round-trip - the multi-round path: regenerate the guide, reload,
// same tab. Nothing is committed to the live state until every guide validation has passed; the
// caller commits the returned root (copy-on-write - the live root is never edited in place).
export async function reloadDesk(
	state: ReviewState,
	io: ReloadIo,
	guideSwap: { guide: unknown } | undefined,
): Promise<ReloadOutcome> {
	let validatedGuide: Guide | undefined
	if (guideSwap) {
		const validation = validateGuide(guideSwap.guide)
		if (!validation.ok)
			return { kind: 'invalid-guide', reason: validation.reason }
		validatedGuide = validation.guide
	}
	const base = await rebuildBase(state, io.git)
	if (!base) return await reloadEmpty(state, io)
	let merged = await mergeReviewState(base, state, io.git)
	// A posted guide replaces the carried one, stamped with the diff it describes as of now so
	// it isn't born stale; a reload without one leaves the carried guide alone.
	if (validatedGuide)
		merged = {
			...merged,
			guide: { ...validatedGuide, baseDiffHash: merged.baseDiffHash },
		}
	const snapshot = await readStagedSnapshot(merged, io.git)
	const persisted = await io.store.persistReview({ ...merged, ...snapshot })
	return {
		kind: 'reloaded',
		state: { ...merged, ...snapshot, ...persisted.stamp },
		baseDiffHash: merged.baseDiffHash,
	}
}

async function rebuildBase(
	state: ReviewState,
	git: GitPort,
): Promise<ReviewState | null> {
	return await buildReviewState(
		state.root,
		{
			mode: state.mode,
			session: state.session,
			staged: state.staged,
			path: state.mode === 'file' ? state.target : undefined,
			target: state.mode === 'pr' ? state.target : undefined,
			base: state.mode === 'pr' ? state.base : undefined,
		},
		git,
	)
}

// An empty rebuild keeps the desk up with an empty diff (whether to open an empty desk at all is
// the startup decision). It deliberately does NOT run mergeReviewState/readStagedSnapshot
// reconciliation - that divergence predates this cleanup and is preserved here.
async function reloadEmpty(
	state: ReviewState,
	io: ReloadIo,
): Promise<ReloadOutcome> {
	const emptied: ReviewState = {
		...state,
		files: [],
		changes: [],
		rawDiff: '',
		baseDiffHash: hash(''),
	}
	const persisted = await io.store.persistReview(emptied)
	return {
		kind: 'empty',
		state: { ...emptied, ...persisted.stamp },
		baseDiffHash: emptied.baseDiffHash,
	}
}
