import { validateGuide } from '../guide.js'
import { buildReviewState } from '../state/build.js'
import { hash } from '../state/identity.js'
import { mergeReviewState, readStagedSnapshot } from '../state/reconcile.js'

import type { Guide, ReviewState } from '../types.js'

export type ReloadOutcome =
	| { kind: 'reloaded'; baseDiffHash: string }
	| { kind: 'empty'; baseDiffHash: string }
	| { kind: 'invalid-guide'; reason: string }

// Re-diff the review and fold it into the live state so the open desk reflects the agent's edits
// without a restart. Rebuilds using the stored mode params; an optional { guide } in the body swaps
// the attached guide in the same round-trip - the multi-round path: regenerate the guide, reload,
// same tab. Nothing is committed to the live state until every guide validation has passed.
export async function reloadDesk(
	state: ReviewState,
	persist: () => Promise<string>,
	rawBody: string,
): Promise<ReloadOutcome> {
	const postedGuide = reloadGuide(rawBody)
	let validatedGuide: Guide | undefined
	if (postedGuide.present) {
		const validation = validateGuide(postedGuide.guide)
		if (!validation.ok)
			return { kind: 'invalid-guide', reason: validation.reason }
		validatedGuide = validation.guide
	}
	const base = await rebuildBase(state)
	if (!base) return await reloadEmpty(state, persist)
	const merged = await mergeReviewState(base, state)
	Object.assign(state, merged)
	// A posted guide replaces the carried one, stamped with the diff it describes as of now so it
	// isn't born stale; a reload without one leaves the carried guide alone.
	if (validatedGuide)
		Object.assign(state, {
			guide: { ...validatedGuide, baseDiffHash: state.baseDiffHash },
		})
	Object.assign(state, await readStagedSnapshot(state))
	await persist()
	return { kind: 'reloaded', baseDiffHash: state.baseDiffHash }
}

// The `guide` field of the reload body, if it carries one. A body that is empty, non-JSON, or has no
// `guide` key means "keep the guide I have" - legacy callers post nothing and the CLI omits the key.
// `present` is explicit because `guide: null` is a posted (invalid) guide, not an absent one.
type ReloadGuide = { present: true; guide: unknown } | { present: false }

function reloadGuide(rawBody: string): ReloadGuide {
	if (!rawBody) return { present: false }
	let parsed: unknown
	try {
		parsed = JSON.parse(rawBody)
	} catch {
		return { present: false } // tolerate empty/non-JSON bodies (legacy callers)
	}
	if (typeof parsed !== 'object' || parsed === null || !('guide' in parsed))
		return { present: false }
	return { present: true, guide: parsed.guide }
}

async function rebuildBase(state: ReviewState): Promise<ReviewState | null> {
	return await buildReviewState(state.root, {
		mode: state.mode,
		session: state.session,
		staged: state.staged,
		path: state.mode === 'file' ? state.target : undefined,
		target: state.mode === 'pr' ? state.target : undefined,
		base: state.mode === 'pr' ? state.base : undefined,
	})
}

// An empty rebuild keeps the desk up with an empty diff (whether to open an empty desk at all is the
// startup decision). It deliberately does NOT run mergeReviewState/readStagedSnapshot reconciliation -
// that divergence predates this cleanup and is preserved here.
async function reloadEmpty(
	state: ReviewState,
	persist: () => Promise<string>,
): Promise<ReloadOutcome> {
	Object.assign(state, {
		files: [],
		changes: [],
		rawDiff: '',
		baseDiffHash: hash(''),
	})
	await persist()
	return { kind: 'empty', baseDiffHash: state.baseDiffHash }
}
